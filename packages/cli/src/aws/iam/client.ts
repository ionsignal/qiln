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
import {
  FOUNDATION,
  digest,
  isPolicy,
  isSpec,
  normalize,
  policyArn,
  policyName,
  sameSnapshot,
  validVersionId,
  type PermissionSpec,
  type PolicyIdentity,
  type PolicySnapshot,
} from '../foundation/policy'
import { isRecord } from '../guards'
import { document, sameJson } from '../json'
import { collect, poll } from '../observe'
import { OPERATOR_PATH, operatorArn, operatorName, operatorTags } from '../operator'
import { AWS_SPEC } from '../spec'
import type { AwsIdentity, PolicyBinding } from '../types'
import { POLICY, review, sameReview, selfService } from './policy'
import type {
  Binding,
  FoundationChange,
  FoundationInspection,
  LoginObservation,
  PasswordReceipt,
  PolicyReview,
  Readiness,
  Target,
} from './types'

interface Entity {
  kind: 'user' | 'group' | 'role'
  name: string | undefined
  id: string | undefined
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

  private async baseline(
    binding: Binding,
    stage: Stage,
    signIn: PolicyReview,
    foundationArn: string | null = null,
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
    const expectedAttachments = [
      ...(stage === 'empty' ? [] : [POLICY.managedArn]),
      ...(foundationArn === null ? [] : [foundationArn]),
    ]
    const actualAttachments = attachments.map(policy => policy.PolicyArn)
    if (
      actualAttachments.some(value => typeof value !== 'string' || !expectedAttachments.includes(value)) ||
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
    const complete =
      actualAttachments.length === expectedAttachments.length && inlineNames.length === expectedInline.length
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
    policyArn: string,
    usage: 'PermissionsPolicy' | 'PermissionsBoundary',
    signal?: AbortSignal,
  ): Promise<Entity[]> {
    return await collect<Entity>(async Marker => {
      const response = await this.client.send(
        new ListEntitiesForPolicyCommand({
          PolicyArn: policyArn,
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

  private policyIdentity(target: Target, policy: Policy | undefined, value: string): PolicyIdentity {
    const result: PolicyIdentity = {
      arn: policy?.Arn ?? '',
      id: policy?.PolicyId ?? '',
      versionId: policy?.DefaultVersionId ?? '',
      document: value,
      sha256: digest(value),
    }
    if (
      !isPolicy(result) ||
      result.arn !== policyArn(target.accountId, target.connection) ||
      policy?.PolicyName !== policyName(target.connection) ||
      policy.Path !== FOUNDATION.path ||
      policy.IsAttachable !== true ||
      policy.PermissionsBoundaryUsageCount !== 0
    ) {
      return conflict()
    }
    return result
  }

  private async snapshot(
    binding: Binding,
    attached: boolean,
    signal?: AbortSignal,
    propagating = false,
  ): Promise<PolicySnapshot | null> {
    let policy: Policy | undefined
    try {
      const response = await this.client.send(
        new GetPolicyCommand({
          PolicyArn: policyArn(binding.accountId, binding.connection),
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
          PolicyArn: policyArn(binding.accountId, binding.connection),
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
    const observed = this.policyIdentity(binding, policy, normalize(value))
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
      entities.some(
        entity =>
          entity.kind !== 'user' ||
          entity.name !== operatorName(binding.connection) ||
          entity.id !== binding.operator.userId,
      ) ||
      entities.length > 1
    ) {
      return conflict()
    }
    const expectedCount = attached ? 1 : 0
    if (entities.length !== expectedCount || policy.AttachmentCount !== expectedCount) {
      if (
        propagating &&
        attached &&
        (entities.length === 0 || entities.length === 1) &&
        (policy.AttachmentCount === 0 || policy.AttachmentCount === 1)
      ) {
        return null
      }
      return conflict()
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
      versions.length > FOUNDATION.maximumVersions ||
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
    }
  }

  public async foundationAbsent(target: Target): Promise<void> {
    try {
      await this.client.send(
        new GetPolicyCommand({
          PolicyArn: policyArn(target.accountId, target.connection),
        }),
        this.options(),
      )
    } catch (error: unknown) {
      if (hasName(error, 'NoSuchEntityException')) {
        return
      }
      throw error
    }
    return conflict()
  }

  /**
   * The binding authenticates the policy's identity, not its cached document.
   * Live content is observed so a different document can receive a new review.
   */
  public async inspectFoundation(
    binding: Binding,
    bound: PolicyBinding | null,
    attached = true,
    loginState: 'present' | 'absent' = 'present',
  ): Promise<FoundationInspection> {
    if (bound && bound.arn !== policyArn(binding.accountId, binding.connection)) {
      return ownershipFailed()
    }
    const signIn = await this.review()
    await this.baseline(binding, 'self', signIn, bound && attached ? bound.arn : null)
    const login = await this.login(binding)
    if ((login !== null) !== (loginState === 'present')) {
      return conflict()
    }
    const observed = await this.snapshot(binding, bound !== null && attached)
    if (bound === null) {
      if (observed !== null) {
        return conflict()
      }
    } else if (!observed?.policy || observed.policy.arn !== bound.arn || observed.policy.id !== bound.id) {
      return ownershipFailed()
    }
    return {
      signIn,
      login,
      prior: observed ?? { policy: null, versions: [] },
    }
  }

  private async requireInspection(binding: Binding, before: FoundationInspection, attached: boolean): Promise<void> {
    const actual = await this.inspectFoundation(
      binding,
      before.prior.policy,
      attached,
      before.login === null ? 'absent' : 'present',
    )
    if (!sameJson(actual, before)) {
      return conflict()
    }
  }

  public async createFoundation(
    binding: Binding,
    spec: PermissionSpec,
    before: FoundationInspection,
  ): Promise<PolicyIdentity> {
    if (before.prior.policy !== null || !isSpec(spec, binding.accountId, binding.connection)) {
      return conflict()
    }
    await this.requireInspection(binding, before, false)
    const response = await this.client.send(
      new CreatePolicyCommand({
        PolicyName: policyName(binding.connection),
        Path: FOUNDATION.path,
        PolicyDocument: spec.document,
        Description: 'Qiln single-host AWS foundation authority',
        Tags: expectedTags(binding),
      }),
      this.options(),
    )
    const policy = response.Policy
    const created: PolicyIdentity = {
      arn: policy?.Arn ?? '',
      id: policy?.PolicyId ?? '',
      versionId: policy?.DefaultVersionId ?? '',
      document: spec.document,
      sha256: spec.sha256,
    }
    if (
      !isPolicy(created) ||
      created.arn !== policyArn(binding.accountId, binding.connection) ||
      policy?.PolicyName !== policyName(binding.connection) ||
      policy.Path !== FOUNDATION.path ||
      created.versionId !== 'v1'
    ) {
      return verificationFailed()
    }
    return created
  }

  public async attachFoundation(binding: Binding, before: FoundationInspection): Promise<PolicyIdentity> {
    const policy = before.prior.policy
    if (!policy) {
      return conflict()
    }
    await this.requireInspection(binding, before, false)
    await this.client.send(
      new AttachUserPolicyCommand({
        UserName: operatorName(binding.connection),
        PolicyArn: policy.arn,
      }),
      this.options(),
    )
    return policy
  }

  public async replaceFoundation(
    binding: Binding,
    spec: PermissionSpec,
    before: FoundationInspection,
  ): Promise<PolicyIdentity> {
    const previous = before.prior.policy
    if (!previous || !isSpec(spec, binding.accountId, binding.connection)) {
      return conflict()
    }
    await this.requireInspection(binding, before, true)
    if (before.prior.versions.length >= FOUNDATION.maximumVersions) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_VERSION_LIMIT',
      })
    }
    const response = await this.client.send(
      new CreatePolicyVersionCommand({
        PolicyArn: previous.arn,
        PolicyDocument: spec.document,
        SetAsDefault: true,
      }),
      this.options(),
    )
    const version = response.PolicyVersion
    if (
      !version ||
      !validVersionId(version.VersionId) ||
      version.IsDefaultVersion !== true ||
      before.prior.versions.includes(version.VersionId)
    ) {
      return verificationFailed()
    }
    return {
      arn: previous.arn,
      id: previous.id,
      versionId: version.VersionId,
      document: spec.document,
      sha256: spec.sha256,
    }
  }

  public async verifyFoundationChange(binding: Binding, change: FoundationChange): Promise<void> {
    const attached = change.action !== 'create'
    const expected: PolicySnapshot = {
      policy: change.policy,
      versions:
        change.action === 'create'
          ? [change.policy.versionId]
          : change.action === 'replace'
            ? [...change.before.prior.versions, change.policy.versionId].sort()
            : [...change.before.prior.versions],
    }
    await poll(async signal => {
      if (
        !(await this.baseline(
          binding,
          'self',
          change.before.signIn,
          attached ? change.policy.arn : null,
          signal,
          true,
        ))
      ) {
        return false
      }
      const login = await this.login(binding, signal)
      if (!sameJson(login, change.before.login)) {
        return conflict()
      }
      const actual = await this.snapshot(binding, attached, signal, true)
      if (!actual) {
        return false
      }
      if (sameSnapshot(actual, expected)) {
        return true
      }
      if (
        change.action === 'replace' &&
        sameJson(actual.policy, change.before.prior.policy) &&
        (sameJson(actual.versions, change.before.prior.versions) || sameJson(actual.versions, expected.versions))
      ) {
        return false
      }
      if (
        sameJson(actual.policy, expected.policy) &&
        actual.versions.every(version => expected.versions.includes(version)) &&
        expected.versions.some(version => !actual.versions.includes(version))
      ) {
        return false
      }
      return conflict()
    }, VERIFICATION)
  }

  public async verifyFoundation(
    binding: Binding,
    signIn: PolicyReview,
    policy: PolicyIdentity,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.baseline(binding, 'self', signIn, policy.arn, signal)
    const actual = await this.snapshot(binding, true, signal)
    if (!actual?.policy || !sameJson(actual.policy, policy)) {
      return conflict()
    }
  }

  public async create(target: Target, signIn: PolicyReview): Promise<AwsIdentity> {
    await this.requireReview(signIn)
    await this.absent(target)
    await this.foundationAbsent(target)
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
      if (!(await this.baseline(binding, 'empty', signIn, null, signal, true))) {
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
      if (!(await this.baseline(binding, stage, signIn, null, signal, true))) {
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
    policy: PolicyIdentity,
    retain: (receipt: PasswordReceipt) => Promise<void>,
  ): Promise<PasswordReceipt> {
    requireTerminal()
    const minimum = await this.minimum()
    await this.verifyFoundation(binding, signIn, policy)
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
    policy: PolicyIdentity,
    receipt: PasswordReceipt,
  ): Promise<Readiness> {
    if (!receipt.delivered) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE',
      })
    }
    await this.verifyFoundation(binding, signIn, policy)
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
    policy: PolicyIdentity,
    receipt: PasswordReceipt,
  ): Promise<void> {
    const readiness = await this.readiness(binding, signIn, policy, receipt)
    if (readiness.passwordResetRequired !== false || readiness.accessKeys !== 0) {
      return conflict()
    }
    const actual = await this.snapshot(binding, true)
    if (!actual || !sameSnapshot(actual, { policy, versions: [policy.versionId] })) {
      return conflict()
    }
  }
}
