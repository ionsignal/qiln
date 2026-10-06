import {
  AttachUserPolicyCommand,
  CreateLoginProfileCommand,
  CreateUserCommand,
  GetAccountPasswordPolicyCommand,
  GetAccountSummaryCommand,
  GetLoginProfileCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetUserCommand,
  GetUserPolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListMFADevicesCommand,
  ListUserPoliciesCommand,
  ListUserTagsCommand,
  PutUserPolicyCommand,
  type AttachedPolicy,
  type LoginProfile,
  type User,
} from '@aws-sdk/client-iam'
import { randomInt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { InstallerError } from '../../diagnostic/error'
import { requireTerminal, reveal } from '../../terminal/secret'
import { requireIdentity, verifyIdentity } from '../auth/identity'
import { AWS_SPEC } from '../spec'
import { isRecord, type AwsIdentity } from '../types'
import { arn, document, name, POLICY, review, sameReview, selfService, tags } from './policy'
import type { BootstrapRecord, PolicyReview, Readiness } from './types'

interface Page<T> {
  items: readonly T[]
  truncated?: boolean
  marker?: string
}

const VERIFICATION_TIMEOUT_MS = 15_000
const VERIFICATION_DELAY_MS = 1_000
const VERIFICATION_ATTEMPTS = 8

function inspectionFailed(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_INSPECTION_FAILED',
  })
}

function verificationFailed(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_VERIFICATION_FAILED',
  })
}

function conflict(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_CONFLICT',
  })
}

function ownershipFailed(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_OWNERSHIP_INVALID',
  })
}

function hasName(error: unknown, expected: string): boolean {
  return isRecord(error) && error.name === expected
}

/**
 * Only an explicitly missing expected artifact returns false. Incompatible
 * state and request failures escape immediately; mutations are never retried.
 */
async function verify(read: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
  const signal = AbortSignal.timeout(VERIFICATION_TIMEOUT_MS)
  try {
    for (let attempt = 0; attempt < VERIFICATION_ATTEMPTS; attempt++) {
      signal.throwIfAborted()
      if (await read(signal)) {
        return
      }
      if (attempt + 1 < VERIFICATION_ATTEMPTS) {
        await delay(VERIFICATION_DELAY_MS, undefined, { signal })
      }
    }
  } catch (error: unknown) {
    if (signal.aborted) {
      return verificationFailed()
    }
    throw error
  }
  return verificationFailed()
}

async function collect<T>(read: (marker?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = []
  const markers = new Set<string>()
  let marker: string | undefined
  for (let page = 0; page < AWS_SPEC.bootstrap.maximumPages; page++) {
    const result = await read(marker)
    items.push(...result.items)
    if (result.truncated !== true) {
      return items
    }
    if (!result.marker || markers.has(result.marker)) {
      return inspectionFailed()
    }
    markers.add(result.marker)
    marker = result.marker
  }
  return inspectionFailed()
}

function account(record: BootstrapRecord): string {
  if (!record.root) {
    return ownershipFailed()
  }
  return record.root.identity.accountId
}

function identity(user: User | undefined, record: BootstrapRecord): AwsIdentity {
  if (
    !user ||
    user.UserName !== name(record.name) ||
    user.Path !== POLICY.path ||
    user.Arn !== arn(account(record), record.name) ||
    user.PermissionsBoundary !== undefined
  ) {
    return ownershipFailed()
  }
  return verifyIdentity({
    accountId: account(record),
    arn: user.Arn,
    userId: user.UserId,
  })
}

function validProfile(profile: LoginProfile | undefined, userName: string): profile is LoginProfile {
  return (
    profile !== undefined &&
    profile.UserName === userName &&
    profile.CreateDate instanceof Date &&
    Number.isFinite(profile.CreateDate.getTime())
  )
}

function password(minimum: number): string {
  const categories = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$^&*_-+=']
  const alphabet = categories.join('')
  const characters = categories.map(category => category[randomInt(category.length)]!)
  const length = Math.max(32, minimum)
  while (characters.length < length) {
    characters.push(alphabet[randomInt(alphabet.length)]!)
  }
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1)
    const current = characters[index]!
    characters[index] = characters[other]!
    characters[other] = current
  }
  return characters.join('')
}

export class Iam {
  constructor(
    private readonly client: IAMClient,
    private readonly signal: AbortSignal,
  ) {}

  private options(signal?: AbortSignal) {
    return {
      abortSignal: AbortSignal.any([this.signal, signal ?? AbortSignal.timeout(AWS_SPEC.requestTimeoutMs)]),
    }
  }

  public async mfa(): Promise<boolean> {
    const response = await this.client.send(new GetAccountSummaryCommand({}), this.options())
    const enabled = response.SummaryMap?.AccountMFAEnabled
    if (enabled !== 0 && enabled !== 1) {
      return inspectionFailed()
    }
    return enabled === 1
  }

  public async review(): Promise<PolicyReview> {
    const response = await this.client.send(
      new GetPolicyCommand({
        PolicyArn: POLICY.managedArn,
      }),
      this.options(),
    )
    if (response.Policy?.Arn !== POLICY.managedArn || !response.Policy.DefaultVersionId) {
      return inspectionFailed()
    }
    const versionId = response.Policy.DefaultVersionId
    const version = await this.client.send(
      new GetPolicyVersionCommand({
        PolicyArn: POLICY.managedArn,
        VersionId: versionId,
      }),
      this.options(),
    )
    if (version.PolicyVersion?.VersionId !== versionId || version.PolicyVersion.IsDefaultVersion !== true) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
      })
    }
    return review(versionId, version.PolicyVersion.Document)
  }

  public async requireReview(record: BootstrapRecord): Promise<void> {
    if (!record.review || !sameReview(await this.review(), record.review)) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
      })
    }
  }

  private async user(record: BootstrapRecord, signal?: AbortSignal): Promise<User | null> {
    try {
      const response = await this.client.send(
        new GetUserCommand({
          UserName: name(record.name),
        }),
        this.options(signal),
      )
      return response.User ?? inspectionFailed()
    } catch (error: unknown) {
      if (hasName(error, 'NoSuchEntityException')) {
        return null
      }
      throw error
    }
  }

  public async absent(record: BootstrapRecord): Promise<void> {
    if (await this.user(record)) {
      return conflict()
    }
  }

  private async owner(
    record: BootstrapRecord,
    operator: AwsIdentity | null = record.operator,
    signal?: AbortSignal,
    propagating = false,
  ): Promise<boolean> {
    if (!operator) {
      return ownershipFailed()
    }
    const user = await this.user(record, signal)
    if (!user) {
      return propagating ? false : ownershipFailed()
    }
    requireIdentity(identity(user, record), operator)
    const actualTags = await collect(async Marker => {
      const response = await this.client.send(
        new ListUserTagsCommand({
          UserName: name(record.name),
          Marker,
        }),
        this.options(signal),
      )
      return {
        items: response.Tags ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    })
    const expectedTags = tags(account(record), record.name, record.id)
    if (
      actualTags.some(
        actual => !expectedTags.some(expected => actual.Key === expected.Key && actual.Value === expected.Value),
      ) ||
      actualTags.some(actual => actualTags.filter(other => other.Key === actual.Key).length !== 1)
    ) {
      return ownershipFailed()
    }
    if (actualTags.length !== expectedTags.length) {
      return propagating ? false : ownershipFailed()
    }
    return true
  }

  private async profile(record: BootstrapRecord, signal?: AbortSignal): Promise<LoginProfile | null> {
    try {
      const response = await this.client.send(
        new GetLoginProfileCommand({
          UserName: name(record.name),
        }),
        this.options(signal),
      )
      if (!validProfile(response.LoginProfile, name(record.name))) {
        return inspectionFailed()
      }
      return response.LoginProfile
    } catch (error: unknown) {
      if (hasName(error, 'NoSuchEntityException')) {
        return null
      }
      throw error
    }
  }

  private async attached(record: BootstrapRecord, signal?: AbortSignal): Promise<AttachedPolicy[]> {
    return await collect(async Marker => {
      const response = await this.client.send(
        new ListAttachedUserPoliciesCommand({
          UserName: name(record.name),
          Marker,
        }),
        this.options(signal),
      )
      return {
        items: response.AttachedPolicies ?? [],
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    })
  }

  private async inline(record: BootstrapRecord, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.client.send(
        new GetUserPolicyCommand({
          UserName: name(record.name),
          PolicyName: POLICY.inlineName,
        }),
        this.options(signal),
      )
      if (
        response.UserName !== name(record.name) ||
        response.PolicyName !== POLICY.inlineName ||
        document(response.PolicyDocument) !== selfService(account(record), record.name)
      ) {
        return conflict()
      }
      return true
    } catch (error: unknown) {
      if (hasName(error, 'NoSuchEntityException')) {
        return false
      }
      throw error
    }
  }

  public async create(record: BootstrapRecord): Promise<AwsIdentity> {
    await this.absent(record)
    const response = await this.client.send(
      new CreateUserCommand({
        UserName: name(record.name),
        Path: POLICY.path,
        Tags: tags(account(record), record.name, record.id),
      }),
      this.options(),
    )
    const operator = identity(response.User, record)
    await verify(signal => this.owner(record, operator, signal, true))
    return operator
  }

  public async attach(record: BootstrapRecord): Promise<void> {
    await this.owner(record)
    await this.requireReview(record)
    await this.client.send(
      new AttachUserPolicyCommand({
        UserName: name(record.name),
        PolicyArn: POLICY.managedArn,
      }),
      this.options(),
    )
    await verify(async signal => {
      const attached = await this.attached(record, signal)
      if (attached.length > 1 || attached.some(policy => policy.PolicyArn !== POLICY.managedArn)) {
        return conflict()
      }
      return attached.length === 1
    })
  }

  public async grant(record: BootstrapRecord): Promise<void> {
    await this.owner(record)
    await this.client.send(
      new PutUserPolicyCommand({
        UserName: name(record.name),
        PolicyName: POLICY.inlineName,
        PolicyDocument: selfService(account(record), record.name),
      }),
      this.options(),
    )
    await verify(signal => this.inline(record, signal))
  }

  private async minimum(): Promise<number> {
    try {
      const response = await this.client.send(new GetAccountPasswordPolicyCommand({}), this.options())
      const minimum = response.PasswordPolicy?.MinimumPasswordLength
      if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 6 || minimum > 128) {
        return inspectionFailed()
      }
      return minimum
    } catch (error: unknown) {
      if (hasName(error, 'NoSuchEntityException')) {
        return 8
      }
      throw error
    }
  }

  public async password(record: BootstrapRecord): Promise<void> {
    requireTerminal()
    const minimum = await this.minimum()
    await this.owner(record)
    const initialPassword = password(minimum)
    const response = await this.client.send(
      new CreateLoginProfileCommand({
        UserName: name(record.name),
        Password: initialPassword,
        PasswordResetRequired: true,
      }),
      this.options(),
    )
    const profile = response.LoginProfile
    if (!validProfile(profile, name(record.name)) || profile.PasswordResetRequired !== true) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
      })
    }
    await reveal(initialPassword, {
      accountId: account(record),
      operatorName: name(record.name),
    })
    await verify(async signal => {
      const observed = await this.profile(record, signal)
      if (!observed) {
        return false
      }
      if (observed.CreateDate?.getTime() !== profile.CreateDate?.getTime()) {
        return conflict()
      }
      return true
    })
  }

  public async readiness(record: BootstrapRecord): Promise<Readiness> {
    await this.owner(record)
    await this.requireReview(record)
    const userName = name(record.name)
    const groups = await collect(async Marker => {
      const response = await this.client.send(
        new ListGroupsForUserCommand({ UserName: userName, Marker }),
        this.options(),
      )
      return {
        items: response.Groups ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    })
    const keys = await collect(async Marker => {
      const response = await this.client.send(new ListAccessKeysCommand({ UserName: userName, Marker }), this.options())
      return {
        items: response.AccessKeyMetadata ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    })
    if (groups.length !== 0 || keys.length !== 0) {
      return conflict()
    }
    const attached = await this.attached(record)
    if (attached.length !== 1 || attached.some(policy => policy.PolicyArn !== POLICY.managedArn)) {
      return conflict()
    }
    const inline = await collect(async Marker => {
      const response = await this.client.send(
        new ListUserPoliciesCommand({ UserName: userName, Marker }),
        this.options(),
      )
      return {
        items: response.PolicyNames ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    })
    if (inline.length !== 1 || inline[0] !== POLICY.inlineName || !(await this.inline(record))) {
      return conflict()
    }
    const devices = await collect(async Marker => {
      const response = await this.client.send(new ListMFADevicesCommand({ UserName: userName, Marker }), this.options())
      return {
        items: response.MFADevices ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    })
    if (
      devices.some(
        device => device.UserName !== userName || typeof device.SerialNumber !== 'string' || device.SerialNumber === '',
      )
    ) {
      return conflict()
    }
    const profile = await this.profile(record)
    if (!profile) {
      return conflict()
    }
    if (typeof profile.PasswordResetRequired !== 'boolean') {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_READINESS_UNKNOWN',
      })
    }
    const current = await this.user(record)
    if (!current || !record.operator) {
      return ownershipFailed()
    }
    requireIdentity(identity(current, record), record.operator)
    return {
      passwordResetRequired: profile.PasswordResetRequired,
      mfaDevices: devices.length,
      accessKeys: keys.length,
    }
  }
}
