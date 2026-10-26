import {
  AttachUserPolicyCommand,
  CreateLoginProfileCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
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
  ListEntitiesForPolicyCommand,
  ListGroupsForUserCommand,
  ListMFADevicesCommand,
  ListPolicyTagsCommand,
  ListPolicyVersionsCommand,
  ListUserPoliciesCommand,
  ListUserTagsCommand,
  PutUserPolicyCommand,
  type Policy,
  type Tag,
  type User,
} from '@aws-sdk/client-iam'
import { randomInt } from 'node:crypto'
import { InstallerError } from '../../diagnostic/error'
import { requireTerminal, reveal } from './secret'
import { requireIdentity, verifyIdentity } from '../auth/identity'
import { isRecord } from '../../guards'
import { sameJson } from '../../json'
import { document } from '../permission/document'
import { collect, poll } from '../observe'
import { OPERATOR_PATH, operatorArn, operatorName, operatorTags } from '../operator'
import {
  POLICY_KEYS,
  POLICY_PATH,
  policyMap,
  policyMapAsync,
  type PolicyKey,
  type PolicyMap,
} from '../permission/keys'
import {
  POLICY_LIMITS,
  digest,
  emptySnapshot,
  isPolicy,
  normalize,
  policyArn,
  policyName,
  validVersionId,
  type PolicyIdentity,
  type PolicySnapshot,
} from '../permission/policy'
import { isSpec, type PermissionEvidence } from '../permission/spec'
import { AWS_SPEC } from '../spec'
import type { AwsIdentity, PolicyBinding } from '../types'
import { POLICY, review, sameReview, selfService } from './policy'
import type {
  Binding,
  LoginObservation,
  PasswordReceipt,
  PermissionInspection,
  PolicyReview,
  Readiness,
  Target,
} from './types'

interface Entity {
  kind: 'user' | 'group' | 'role'
  name: string | undefined
  id: string | undefined
}

export interface PolicyChange {
  key: PolicyKey
  before: PolicySnapshot
}

type Stage = 'empty' | 'signin' | 'self'

const PAGES = {
  maxPages: AWS_SPEC.iam.maximumPages,
  code: 'AWS_BOOTSTRAP_INSPECTION_FAILED',
} as const

const VERIFICATION = {
  ...AWS_SPEC.iam.verification,
  code: 'AWS_BOOTSTRAP_VERIFICATION_FAILED',
} as const

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

function identity(user: User | undefined, target: Target): AwsIdentity {
  if (
    !user ||
    user.UserName !== operatorName(target.connection) ||
    user.Path !== OPERATOR_PATH ||
    user.Arn !== operatorArn(target.accountId, target.connection) ||
    user.PermissionsBoundary !== undefined
  ) {
    return ownershipFailed()
  }
  return verifyIdentity({
    accountId: target.accountId,
    arn: user.Arn,
    userId: user.UserId,
  })
}

function expectedTags(target: Target) {
  return operatorTags(target.accountId, target.connection, target.creationId)
}

function checkTags(actual: readonly Tag[], target: Target, propagating: boolean): boolean {
  const expected = expectedTags(target)
  if (
    actual.some(tag => !expected.some(entry => tag.Key === entry.Key && tag.Value === entry.Value)) ||
    new Set(actual.map(tag => tag.Key)).size !== actual.length
  ) {
    return ownershipFailed()
  }
  if (actual.length !== expected.length) {
    return propagating ? false : ownershipFailed()
  }
  return true
}

function attachedPolicyArns(target: Target, policies: PolicyMap<PolicySnapshot>): string[] {
  return POLICY_KEYS.filter(key => policies[key].attached).map(key =>
    policyArn(target.accountId, target.connection, key),
  )
}

/**
 * A step's effect may not be visible yet: nothing is observable, or only states
 * between the prior and the expected snapshot are.
 */
function inTransit(actual: PolicySnapshot | null, before: PolicySnapshot, expected: PolicySnapshot): boolean {
  if (actual === null) {
    return true
  }
  const known = actual.versions.every(version => expected.versions.includes(version))
  return known && (sameJson(actual.policy, before.policy) || sameJson(actual.policy, expected.policy))
}

function password(minimum: number): string {
  const categories = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$^&*_-+=']
  const alphabet = categories.join('')
  const characters = categories.map(category => category[randomInt(category.length)]!)
  while (characters.length < Math.max(32, minimum)) {
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
      abortSignal: AbortSignal.any([
        this.signal,
        AbortSignal.timeout(AWS_SPEC.requestTimeoutMs),
        ...(signal === undefined ? [] : [signal]),
      ]),
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

  public async review(signal?: AbortSignal): Promise<PolicyReview> {
    const response = await this.client.send(
      new GetPolicyCommand({
        PolicyArn: POLICY.managedArn,
      }),
      this.options(signal),
    )
    if (response.Policy?.Arn !== POLICY.managedArn || !validVersionId(response.Policy.DefaultVersionId)) {
      return inspectionFailed()
    }
    const versionId = response.Policy.DefaultVersionId
    const version = await this.client.send(
      new GetPolicyVersionCommand({
        PolicyArn: POLICY.managedArn,
        VersionId: versionId,
      }),
      this.options(signal),
    )
    if (version.PolicyVersion?.VersionId !== versionId || version.PolicyVersion.IsDefaultVersion !== true) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
      })
    }
    return review(versionId, version.PolicyVersion.Document)
  }

  private async requireReview(expected: PolicyReview, signal?: AbortSignal): Promise<void> {
    if (!sameReview(await this.review(signal), expected)) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
      })
    }
  }

  private async user(target: Target, signal?: AbortSignal): Promise<User | null> {
    try {
      const response = await this.client.send(
        new GetUserCommand({
          UserName: operatorName(target.connection),
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

  public async absent(target: Target): Promise<void> {
    if (await this.user(target)) {
      return conflict()
    }
  }

  private async owner(binding: Binding, signal?: AbortSignal, propagating = false): Promise<boolean> {
    const user = await this.user(binding, signal)
    if (!user) {
      return propagating ? false : ownershipFailed()
    }
    requireIdentity(identity(user, binding), binding.operator)
    const actual = await collect(async Marker => {
      const response = await this.client.send(
        new ListUserTagsCommand({
          UserName: operatorName(binding.connection),
          Marker,
        }),
        this.options(signal),
      )
      return {
        items: response.Tags ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    return checkTags(actual, binding, propagating)
  }

  private async login(binding: Binding, signal?: AbortSignal): Promise<LoginObservation | null> {
    try {
      const response = await this.client.send(
        new GetLoginProfileCommand({
          UserName: operatorName(binding.connection),
        }),
        this.options(signal),
      )
      const profile = response.LoginProfile
      if (
        !profile ||
        profile.UserName !== operatorName(binding.connection) ||
        !(profile.CreateDate instanceof Date) ||
        !Number.isFinite(profile.CreateDate.getTime()) ||
        (profile.PasswordResetRequired !== undefined && typeof profile.PasswordResetRequired !== 'boolean')
      ) {
        return inspectionFailed()
      }
      return {
        createdAt: profile.CreateDate.toISOString(),
        passwordResetRequired: profile.PasswordResetRequired ?? null,
      }
    } catch (error: unknown) {
      if (hasName(error, 'NoSuchEntityException')) {
        return null
      }
      throw error
    }
  }

  private async noLogin(binding: Binding, signal?: AbortSignal): Promise<void> {
    if (await this.login(binding, signal)) {
      return conflict()
    }
  }

  /**
   * Checks the user's baseline: owner, no groups or keys, and exactly the
   * expected attachments and inline policy. With `'observed'`, any subset of the
   * managed policies may be attached, and the snapshots report which are.
   */
  private async baseline(
    binding: Binding,
    stage: Stage,
    signIn: PolicyReview,
    policyArns: readonly string[] | 'observed' = [],
    signal?: AbortSignal,
    propagating = false,
  ): Promise<boolean> {
    if (!(await this.owner(binding, signal, propagating))) {
      return false
    }
    await this.requireReview(signIn, signal)
    const userName = operatorName(binding.connection)
    const groups = await collect(async Marker => {
      const response = await this.client.send(
        new ListGroupsForUserCommand({ UserName: userName, Marker }),
        this.options(signal),
      )
      return {
        items: response.Groups ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    const keys = await collect(async Marker => {
      const response = await this.client.send(
        new ListAccessKeysCommand({ UserName: userName, Marker }),
        this.options(signal),
      )
      return {
        items: response.AccessKeyMetadata ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    if (groups.length !== 0 || keys.length !== 0) {
      return conflict()
    }
    const attachments = await collect(async Marker => {
      const response = await this.client.send(
        new ListAttachedUserPoliciesCommand({ UserName: userName, Marker }),
        this.options(signal),
      )
      return {
        items: response.AttachedPolicies ?? [],
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    const actualAttachments = attachments.map(policy => policy.PolicyArn)
    const signInArns = stage === 'empty' ? [] : [POLICY.managedArn]
    const known = POLICY_KEYS.map(key => policyArn(binding.accountId, binding.connection, key))
    const required = [
      ...signInArns,
      ...(policyArns === 'observed' ? known.filter(arn => actualAttachments.includes(arn)) : policyArns),
    ]
    const allowed = policyArns === 'observed' ? [...signInArns, ...known] : required
    if (
      actualAttachments.some(value => typeof value !== 'string' || !allowed.includes(value)) ||
      new Set(actualAttachments).size !== actualAttachments.length
    ) {
      return conflict()
    }
    const inlineNames = await collect(async Marker => {
      const response = await this.client.send(
        new ListUserPoliciesCommand({ UserName: userName, Marker }),
        this.options(signal),
      )
      return {
        items: response.PolicyNames ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    const expectedInline: readonly string[] = stage === 'self' ? [POLICY.inlineName] : []
    if (
      inlineNames.some(value => !expectedInline.includes(value)) ||
      new Set(inlineNames).size !== inlineNames.length
    ) {
      return conflict()
    }
    const complete = actualAttachments.length === required.length && inlineNames.length === expectedInline.length
    if (!complete) {
      return propagating ? false : conflict()
    }
    if (stage === 'self') {
      try {
        const response = await this.client.send(
          new GetUserPolicyCommand({
            UserName: userName,
            PolicyName: POLICY.inlineName,
          }),
          this.options(signal),
        )
        if (
          response.UserName !== userName ||
          response.PolicyName !== POLICY.inlineName ||
          document(response.PolicyDocument) !== selfService(binding.accountId, binding.connection)
        ) {
          return conflict()
        }
      } catch (error: unknown) {
        if (propagating && hasName(error, 'NoSuchEntityException')) {
          return false
        }
        throw error
      }
    }
    return true
  }

  private async entities(
    arn: string,
    usage: 'PermissionsPolicy' | 'PermissionsBoundary',
    signal?: AbortSignal,
  ): Promise<Entity[]> {
    return await collect<Entity>(async Marker => {
      const response = await this.client.send(
        new ListEntitiesForPolicyCommand({
          PolicyArn: arn,
          PolicyUsageFilter: usage,
          Marker,
        }),
        this.options(signal),
      )
      return {
        items: [
          ...(response.PolicyUsers ?? []).map(user => ({
            kind: 'user' as const,
            name: user.UserName,
            id: user.UserId,
          })),
          ...(response.PolicyGroups ?? []).map(group => ({
            kind: 'group' as const,
            name: group.GroupName,
            id: group.GroupId,
          })),
          ...(response.PolicyRoles ?? []).map(role => ({
            kind: 'role' as const,
            name: role.RoleName,
            id: role.RoleId,
          })),
        ],
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
  }

  private policyIdentity(target: Target, key: PolicyKey, policy: Policy | undefined, value: string): PolicyIdentity {
    const result: PolicyIdentity = {
      arn: policy?.Arn ?? '',
      id: policy?.PolicyId ?? '',
      versionId: policy?.DefaultVersionId ?? '',
      sha256: digest(value),
    }
    if (
      !isPolicy(result) ||
      result.arn !== policyArn(target.accountId, target.connection, key) ||
      policy?.PolicyName !== policyName(target.connection, key) ||
      policy.Path !== POLICY_PATH ||
      policy.IsAttachable !== true ||
      policy.PermissionsBoundaryUsageCount !== 0
    ) {
      return conflict()
    }
    return result
  }

  /**
   * Observes one policy and whether it is attached to the operator. Null means
   * the policy is absent or, while propagating, not yet fully observable.
   */
  private async snapshot(
    binding: Binding,
    key: PolicyKey,
    signal?: AbortSignal,
    propagating = false,
  ): Promise<PolicySnapshot | null> {
    const arn = policyArn(binding.accountId, binding.connection, key)
    let policy: Policy | undefined
    try {
      const response = await this.client.send(
        new GetPolicyCommand({
          PolicyArn: arn,
        }),
        this.options(signal),
      )
      policy = response.Policy
    } catch (error: unknown) {
      if (hasName(error, 'NoSuchEntityException')) {
        return null
      }
      throw error
    }
    if (!policy || !validVersionId(policy.DefaultVersionId)) {
      return inspectionFailed()
    }
    let value: string | undefined
    try {
      const response = await this.client.send(
        new GetPolicyVersionCommand({
          PolicyArn: arn,
          VersionId: policy.DefaultVersionId,
        }),
        this.options(signal),
      )
      if (
        response.PolicyVersion?.VersionId !== policy.DefaultVersionId ||
        response.PolicyVersion.IsDefaultVersion !== true
      ) {
        return conflict()
      }
      value = response.PolicyVersion.Document
    } catch (error: unknown) {
      if (propagating && hasName(error, 'NoSuchEntityException')) {
        return null
      }
      throw error
    }
    const observed = this.policyIdentity(binding, key, policy, normalize(value))
    const actualTags = await collect(async Marker => {
      const response = await this.client.send(
        new ListPolicyTagsCommand({
          PolicyArn: observed.arn,
          Marker,
        }),
        this.options(signal),
      )
      return {
        items: response.Tags ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    if (!checkTags(actualTags, binding, propagating)) {
      return null
    }
    const entities = await this.entities(observed.arn, 'PermissionsPolicy', signal)
    const boundaries = await this.entities(observed.arn, 'PermissionsBoundary', signal)
    if (
      boundaries.length !== 0 ||
      entities.length > 1 ||
      entities.some(
        entity =>
          entity.kind !== 'user' ||
          entity.name !== operatorName(binding.connection) ||
          entity.id !== binding.operator.userId,
      )
    ) {
      return conflict()
    }
    const count = policy.AttachmentCount
    if (count !== entities.length) {
      return propagating && (count === 0 || count === 1) ? null : conflict()
    }
    const versions = await collect(async Marker => {
      const response = await this.client.send(
        new ListPolicyVersionsCommand({
          PolicyArn: observed.arn,
          Marker,
        }),
        this.options(signal),
      )
      return {
        items: response.Versions ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    if (
      versions.length === 0 ||
      versions.length > POLICY_LIMITS.maximumVersions ||
      versions.some(version => !validVersionId(version.VersionId) || typeof version.IsDefaultVersion !== 'boolean') ||
      new Set(versions.map(version => version.VersionId)).size !== versions.length ||
      versions.filter(version => version.IsDefaultVersion === true).length !== 1 ||
      !versions.some(version => version.VersionId === observed.versionId && version.IsDefaultVersion === true)
    ) {
      return conflict()
    }
    return {
      policy: observed,
      versions: versions.map(version => version.VersionId!).sort(),
      attached: entities.length === 1,
    }
  }

  public async policiesAbsent(target: Target): Promise<void> {
    for (const key of POLICY_KEYS) {
      try {
        await this.client.send(
          new GetPolicyCommand({
            PolicyArn: policyArn(target.accountId, target.connection, key),
          }),
          this.options(),
        )
      } catch (error: unknown) {
        if (hasName(error, 'NoSuchEntityException')) {
          continue
        }
        throw error
      }
      return conflict()
    }
  }

  private async observe(binding: Binding, key: PolicyKey, bound: PolicyBinding | null): Promise<PolicySnapshot> {
    if (bound !== null && bound.arn !== policyArn(binding.accountId, binding.connection, key)) {
      return ownershipFailed()
    }
    const observed = await this.snapshot(binding, key)
    if (bound === null) {
      if (observed !== null) {
        return conflict()
      }
      return emptySnapshot()
    }
    if (!observed?.policy || observed.policy.arn !== bound.arn || observed.policy.id !== bound.id) {
      return ownershipFailed()
    }
    return observed
  }

  /**
   * The binding authenticates a policy's identity, not its cached document.
   * Live content is observed so a different document can receive a new review.
   */
  public async inspect(
    binding: Binding,
    bound: Readonly<Partial<PolicyMap<PolicyBinding | null>>>,
    loginState: 'present' | 'absent' = 'present',
  ): Promise<PermissionInspection> {
    const signIn = await this.review()
    await this.baseline(binding, 'self', signIn, 'observed')
    const login = await this.login(binding)
    if ((login !== null) !== (loginState === 'present')) {
      return conflict()
    }
    return {
      signIn,
      login,
      policies: await policyMapAsync(key => this.observe(binding, key, bound[key] ?? null)),
    }
  }

  private async requireInspection(binding: Binding, before: PermissionInspection): Promise<void> {
    const actual = await this.inspect(
      binding,
      policyMap(key => before.policies[key].policy),
      before.login === null ? 'absent' : 'present',
    )
    if (!sameJson(actual, before)) {
      return conflict()
    }
  }

  public async createPolicy(
    binding: Binding,
    spec: PermissionEvidence,
    key: PolicyKey,
    before: PermissionInspection,
  ): Promise<PolicyIdentity> {
    if (before.policies[key].policy !== null || !isSpec(spec, binding.accountId, binding.connection)) {
      return conflict()
    }
    await this.requireInspection(binding, before)
    const desired = spec.policies[key]
    const response = await this.client.send(
      new CreatePolicyCommand({
        PolicyName: policyName(binding.connection, key),
        Path: POLICY_PATH,
        PolicyDocument: desired.document,
        Description: `Qiln single-host AWS ${key} authority`,
        Tags: expectedTags(binding),
      }),
      this.options(),
    )
    const policy = response.Policy
    const created: PolicyIdentity = {
      arn: policy?.Arn ?? '',
      id: policy?.PolicyId ?? '',
      versionId: policy?.DefaultVersionId ?? '',
      sha256: desired.sha256,
    }
    if (
      !isPolicy(created) ||
      created.arn !== policyArn(binding.accountId, binding.connection, key) ||
      policy?.PolicyName !== policyName(binding.connection, key) ||
      policy.Path !== POLICY_PATH ||
      created.versionId !== 'v1'
    ) {
      return verificationFailed()
    }
    return created
  }

  public async attachPolicy(binding: Binding, key: PolicyKey, before: PermissionInspection): Promise<PolicyIdentity> {
    const policy = before.policies[key].policy
    if (!policy) {
      return conflict()
    }
    await this.requireInspection(binding, before)
    await this.client.send(
      new AttachUserPolicyCommand({
        UserName: operatorName(binding.connection),
        PolicyArn: policy.arn,
      }),
      this.options(),
    )
    return policy
  }

  public async replacePolicy(
    binding: Binding,
    spec: PermissionEvidence,
    key: PolicyKey,
    before: PermissionInspection,
  ): Promise<PolicyIdentity> {
    const previous = before.policies[key].policy
    if (!previous || !isSpec(spec, binding.accountId, binding.connection)) {
      return conflict()
    }
    await this.requireInspection(binding, before)
    const retained = before.policies[key].versions
    if (retained.length >= POLICY_LIMITS.maximumVersions) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_VERSION_LIMIT',
      })
    }
    const desired = spec.policies[key]
    const response = await this.client.send(
      new CreatePolicyVersionCommand({
        PolicyArn: previous.arn,
        PolicyDocument: desired.document,
        SetAsDefault: true,
      }),
      this.options(),
    )
    const version = response.PolicyVersion
    if (
      !version ||
      !validVersionId(version.VersionId) ||
      version.IsDefaultVersion !== true ||
      retained.includes(version.VersionId)
    ) {
      return verificationFailed()
    }
    return {
      arn: previous.arn,
      id: previous.id,
      versionId: version.VersionId,
      sha256: desired.sha256,
    }
  }

  /**
   * Polls until the live state equals `expected`. Only the policy named by
   * `change` may still show its earlier state while the step propagates.
   */
  public async verifyPermissions(
    binding: Binding,
    expected: PermissionInspection,
    change: PolicyChange | null,
  ): Promise<void> {
    await poll(async signal => {
      const arns = attachedPolicyArns(binding, expected.policies)
      if (!(await this.baseline(binding, 'self', expected.signIn, arns, signal, true))) {
        return false
      }
      if (!sameJson(await this.login(binding, signal), expected.login)) {
        return conflict()
      }
      let settled = true
      for (const key of POLICY_KEYS) {
        const actual = await this.snapshot(binding, key, signal, true)
        const wanted = expected.policies[key]
        // A key that is not enrolled yet is expected to be absent from IAM.
        if (sameJson(actual, wanted) || (actual === null && wanted.policy === null)) {
          continue
        }
        if (change?.key === key && inTransit(actual, change.before, wanted)) {
          settled = false
          continue
        }
        return conflict()
      }
      return settled
    }, VERIFICATION)
  }

  public async verifyPolicies(
    binding: Binding,
    signIn: PolicyReview,
    policies: PolicyMap<PolicySnapshot>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.baseline(binding, 'self', signIn, attachedPolicyArns(binding, policies), signal)
    for (const key of POLICY_KEYS) {
      if (!sameJson(await this.snapshot(binding, key, signal), policies[key])) {
        return conflict()
      }
    }
  }

  public async create(target: Target, signIn: PolicyReview): Promise<AwsIdentity> {
    await this.requireReview(signIn)
    await this.absent(target)
    await this.policiesAbsent(target)
    const response = await this.client.send(
      new CreateUserCommand({
        UserName: operatorName(target.connection),
        Path: OPERATOR_PATH,
        Tags: expectedTags(target),
      }),
      this.options(),
    )
    return identity(response.User, target)
  }

  public async verifyUser(binding: Binding, signIn: PolicyReview): Promise<void> {
    await poll(async signal => {
      if (!(await this.baseline(binding, 'empty', signIn, [], signal, true))) {
        return false
      }
      await this.noLogin(binding, signal)
      return true
    }, VERIFICATION)
  }

  public async attach(binding: Binding, signIn: PolicyReview): Promise<void> {
    await this.baseline(binding, 'empty', signIn)
    await this.noLogin(binding)
    await this.client.send(
      new AttachUserPolicyCommand({
        UserName: operatorName(binding.connection),
        PolicyArn: POLICY.managedArn,
      }),
      this.options(),
    )
  }

  public async grant(binding: Binding, signIn: PolicyReview): Promise<void> {
    await this.baseline(binding, 'signin', signIn)
    await this.noLogin(binding)
    await this.client.send(
      new PutUserPolicyCommand({
        UserName: operatorName(binding.connection),
        PolicyName: POLICY.inlineName,
        PolicyDocument: selfService(binding.accountId, binding.connection),
      }),
      this.options(),
    )
  }

  public async verifyStage(binding: Binding, signIn: PolicyReview, stage: 'signin' | 'self'): Promise<void> {
    await poll(async signal => {
      if (!(await this.baseline(binding, stage, signIn, [], signal, true))) {
        return false
      }
      await this.noLogin(binding, signal)
      return true
    }, VERIFICATION)
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

  public async password(
    binding: Binding,
    signIn: PolicyReview,
    policies: PolicyMap<PolicySnapshot>,
    retain: (receipt: PasswordReceipt) => Promise<void>,
  ): Promise<PasswordReceipt> {
    requireTerminal()
    const minimum = await this.minimum()
    await this.verifyPolicies(binding, signIn, policies)
    await this.noLogin(binding)
    const initialPassword = password(minimum)
    const response = await this.client.send(
      new CreateLoginProfileCommand({
        UserName: operatorName(binding.connection),
        Password: initialPassword,
        PasswordResetRequired: true,
      }),
      this.options(),
    )
    const profile = response.LoginProfile
    if (
      !profile ||
      profile.UserName !== operatorName(binding.connection) ||
      !(profile.CreateDate instanceof Date) ||
      !Number.isFinite(profile.CreateDate.getTime()) ||
      profile.PasswordResetRequired !== true
    ) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
      })
    }
    const receipt: PasswordReceipt = {
      createdAt: profile.CreateDate.toISOString(),
      delivered: false,
    }
    await retain(receipt)
    await reveal(initialPassword, {
      accountId: binding.accountId,
      operatorName: operatorName(binding.connection),
    })
    return {
      ...receipt,
      delivered: true,
    }
  }

  public async verifyPassword(binding: Binding, receipt: PasswordReceipt): Promise<void> {
    if (!receipt.delivered) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
      })
    }
    await poll(async signal => {
      const actual = await this.login(binding, signal)
      if (!actual) {
        return false
      }
      if (actual.createdAt !== receipt.createdAt) {
        return conflict()
      }
      return true
    }, VERIFICATION)
  }

  public async readiness(
    binding: Binding,
    signIn: PolicyReview,
    policies: PolicyMap<PolicySnapshot>,
    receipt: PasswordReceipt,
  ): Promise<Readiness> {
    if (!receipt.delivered) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
      })
    }
    await this.verifyPolicies(binding, signIn, policies)
    const userName = operatorName(binding.connection)
    const devices = await collect(async Marker => {
      const response = await this.client.send(
        new ListMFADevicesCommand({ UserName: userName, Marker }),
        this.options(),
      )
      return {
        items: response.MFADevices ?? inspectionFailed(),
        truncated: response.IsTruncated,
        marker: response.Marker,
      }
    }, PAGES)
    if (
      devices.some(
        device => device.UserName !== userName || typeof device.SerialNumber !== 'string' || device.SerialNumber === '',
      ) ||
      new Set(devices.map(device => device.SerialNumber)).size !== devices.length
    ) {
      return conflict()
    }
    const login = await this.login(binding)
    if (!login || login.createdAt !== receipt.createdAt) {
      return conflict()
    }
    if (login.passwordResetRequired === null) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_READINESS_UNKNOWN',
      })
    }
    return {
      passwordResetRequired: login.passwordResetRequired,
      mfaDevices: devices.length,
      accessKeys: 0,
    }
  }

  public async verifyOnboarding(
    binding: Binding,
    signIn: PolicyReview,
    policies: PolicyMap<PolicySnapshot>,
    receipt: PasswordReceipt,
  ): Promise<void> {
    const readiness = await this.readiness(binding, signIn, policies, receipt)
    if (readiness.passwordResetRequired !== false || readiness.accessKeys !== 0) {
      return conflict()
    }
  }
}
