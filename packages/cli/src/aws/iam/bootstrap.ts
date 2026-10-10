import { randomUUID } from 'node:crypto'
import { InstallerError, type DiagnosticFact } from '../../diagnostic/error'
import { openChildDir, type Dir } from '../../state/files'
import { checkCancellation } from '../../terminal/prompts'
import { request } from '../child/request'
import { requireAuthentication } from '../auth/identity'
import { login, type AwsCli } from '../auth/login'
import { Session } from '../auth/session'
import { diagnostic } from '../errors'
import { iamRecovery, originalCode, terminationConfirmed, type RecoveryOutcomes } from '../recovery'
import {
  FOUNDATION,
  isGrant,
  isSpec,
  reconciliationMode,
  specification,
  type PolicyIdentity,
} from '../foundation/policy'
import { canonical, sameJson } from '../json'
import { operatorArn } from '../operator'
import { AWS_SPEC } from '../spec'
import { userId } from '../host'
import type { AwsAuthentication, AwsConnection, LoginFlow } from '../types'
import { pendingFacts } from './facts'
import * as journal from './journal'
import * as lifecycle from './lifecycle'
import { isPasswordEvidence, type PasswordAcknowledgment, type PasswordEvidence } from './password'
import { isReply, type Action, type Request, type Result } from './protocol'
import * as transitions from './transitions'
import {
  isInspection,
  isMutationResult,
  type Inspection,
  type MutationAction,
  type MutationProgress,
  type MutationResult,
  type Pending,
  type Proposal,
  type Readiness,
} from './types'

function emitProgress(onProgress: ((event: MutationProgress) => void) | undefined, event: MutationProgress): void {
  try {
    onProgress?.(event)
  } catch {
    // Presentation cannot decide whether an IAM mutation completed or verified.
  }
}

/**
 * Commands own approval presentation. This coordinator owns the protected
 * pending authority and the lifetime of its separate root authentication.
 */
export class Bootstrap {
  private session: Session | undefined
  private inspection: Inspection | undefined
  private rootCleaned = false
  private closed = false

  private constructor(
    private readonly directory: Dir,
    private current: Pending,
  ) {}

  private static async start(directory: Dir, record: Pending): Promise<Bootstrap> {
    const operation = new Bootstrap(directory, record)
    try {
      const root = await openChildDir(
        directory,
        AWS_SPEC.state.root,
        {
          owner: userId(),
          mode: 0o700,
        },
        true,
      )
      if ((await root.list()).length !== 0) {
        throw new InstallerError({
          code: 'AWS_PERMISSION_STATE_INVALID',
        })
      }
      operation.session = await Session.create(root, record.region)
      return operation
    } catch (error: unknown) {
      return await operation.fail(error)
    }
  }

  public static async onboard(directory: Dir, name: string, region: string): Promise<Bootstrap> {
    return await Bootstrap.start(directory, await lifecycle.onboard(directory, name, region))
  }

  public static async maintain(directory: Dir, connection: AwsConnection): Promise<Bootstrap> {
    return await Bootstrap.start(directory, await lifecycle.maintain(directory, connection))
  }

  public get record(): Pending {
    return journal.copy(this.current)
  }

  private requireOpen(confirmed = true): void {
    if (
      this.closed ||
      this.current.failureCode !== null ||
      this.current.cleanup !== 'pending' ||
      (confirmed && this.current.termination !== 'confirmed')
    ) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_RECORDED',
        facts: pendingFacts(this.current),
      })
    }
  }

  private async persist(changes: Partial<Pending>): Promise<void> {
    const updated = journal.parse({
      ...this.current,
      ...changes,
    })
    // A rename can precede a failed directory sync. Retain the intended record
    // for recovery reporting without claiming that persistence succeeded.
    this.current = updated
    await journal.save(this.directory, updated)
  }

  private credentialEnvironment(): NodeJS.ProcessEnv {
    if (!this.session) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    return this.session.credentialEnvironment()
  }

  private ownsPasswordEvidence(message: unknown): message is PasswordEvidence {
    return (
      isPasswordEvidence(message) &&
      message.operationId === this.current.id &&
      message.mutationId === this.current.mutation?.id
    )
  }

  /**
   * The password never leaves its child. Only the creation receipt is retained,
   * and the child may write the password to the terminal only after the
   * acknowledgment returned here.
   */
  private async retainPasswordEvidence(message: unknown): Promise<PasswordAcknowledgment> {
    const mutation = this.current.mutation
    if (
      !this.ownsPasswordEvidence(message) ||
      !mutation ||
      mutation.action !== 'password' ||
      mutation.returned !== null ||
      mutation.verifiedAt !== null ||
      this.current.password !== null
    ) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    await this.persist({
      mutation: {
        ...mutation,
        returned: {
          kind: 'password',
          receipt: { ...message.receipt },
        },
      },
      password: { ...message.receipt },
    })
    return {
      kind: 'password-retained',
      operationId: message.operationId,
      mutationId: message.mutationId,
    }
  }

  private async call(action: Action, signal: AbortSignal): Promise<Result> {
    this.requireOpen(false)
    checkCancellation(signal)
    await this.persist({
      termination: 'unconfirmed',
    })
    const input: Request = {
      kind: action,
      operationId: this.current.id,
      region: this.current.region,
    }
    const passwordRequest = action === 'mutate' && this.current.mutation?.action === 'password'
    const reply = await request(
      AWS_SPEC.children.iam,
      this.credentialEnvironment(),
      input,
      isReply,
      signal,
      {
        timeoutMs: AWS_SPEC.iam.requestTimeoutMs,
        terminal: passwordRequest,
        ...(passwordRequest
          ? {
              evidence: {
                accept: (message: unknown) => this.ownsPasswordEvidence(message),
                retain: (message: unknown) => this.retainPasswordEvidence(message),
              },
            }
          : {}),
      },
    )
    await this.persist({
      termination: 'confirmed',
    })
    if (!reply.ok) {
      throw new InstallerError({
        code: reply.code,
      })
    }
    return reply.result
  }

  public async login(cli: AwsCli, flow: LoginFlow, signal: AbortSignal): Promise<void> {
    this.requireOpen()
    if (!this.session || this.current.approval !== null) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    checkCancellation(signal)
    await this.persist({
      termination: 'unconfirmed',
    })
    await login(cli, this.session, flow, signal)
    await this.persist({
      termination: 'confirmed',
    })
  }

  public async inspect(signal: AbortSignal): Promise<Inspection> {
    this.requireOpen()
    if (this.current.approval !== null) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    const result = await this.call('inspect', signal)
    if (
      result.kind !== 'inspection' ||
      !isInspection(result.inspection) ||
      (this.current.accountId !== null &&
        result.inspection.root.identity.accountId !== this.current.accountId) ||
      (this.current.kind === 'onboard'
        ? result.inspection.before !== null
        : result.inspection.before?.login == null)
    ) {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.persist({
      accountId: result.inspection.root.identity.accountId,
    })
    this.inspection = result.inspection
    return this.copyInspection()
  }

  private copyInspection(): Inspection {
    if (!this.inspection) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    const copy: unknown = JSON.parse(canonical(this.inspection))
    if (!isInspection(copy)) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    return copy
  }

  public proposal(): Proposal {
    this.requireOpen()
    if (this.current.approval !== null || this.current.accountId === null) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    const inspection = this.copyInspection()
    const permission = specification(this.current.accountId, this.current.name, this.current.region)
    if (
      this.current.kind === 'maintain' &&
      inspection.before !== null &&
      reconciliationMode(inspection.before.prior, permission) === 'replace' &&
      inspection.before.prior.versions.length >= FOUNDATION.maximumVersions
    ) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_VERSION_LIMIT',
      })
    }
    return {
      operationId: this.current.id,
      kind: this.current.kind,
      operatorArn: this.current.operator?.arn ?? operatorArn(this.current.accountId, this.current.name),
      inspection,
      permission,
    }
  }

  public async approve(proposal: Proposal, signal: AbortSignal): Promise<void> {
    this.requireOpen()
    const expected = this.proposal()
    if (!expected.inspection.root.mfaConfigured) {
      throw new InstallerError({
        code: 'AWS_ROOT_MFA_REQUIRED',
      })
    }
    if (!sameJson(proposal, expected)) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
      })
    }
    checkCancellation(signal)
    await this.persist({
      approval: {
        approvedAt: new Date().toISOString(),
        inspection: expected.inspection,
        permission: expected.permission,
      },
      foundation: expected.inspection.before?.prior.policy ?? null,
    })
  }

  private requirePolicy(policy: PolicyIdentity): void {
    const approval = this.current.approval
    if (
      !approval ||
      this.current.accountId === null ||
      !isGrant(
        {
          spec: approval.permission,
          policy,
        },
        this.current.accountId,
        this.current.name,
      )
    ) {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
  }

  private async retainResult(result: MutationResult): Promise<void> {
    const mutation = this.current.mutation
    if (!mutation || !isMutationResult(result, mutation.action) || mutation.verifiedAt !== null) {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    if (result.kind === 'policy') {
      this.requirePolicy(result.policy)
    }
    await this.persist({
      mutation: {
        ...mutation,
        returned: result,
      },
      ...(result.kind === 'operator' ? { operator: result.identity } : {}),
      ...(result.kind === 'policy' ? { foundation: result.policy } : {}),
      ...(result.kind === 'password' ? { password: result.receipt } : {}),
    })
  }

  private async mutate(
    action: MutationAction,
    signal: AbortSignal,
    onProgress?: (event: MutationProgress) => void,
  ): Promise<void> {
    this.requireOpen()
    checkCancellation(signal)
    await this.persist({
      mutation: {
        id: randomUUID(),
        action,
        approvedAt: new Date().toISOString(),
        before: transitions.before(this.current, action),
        returned: null,
        verifiedAt: null,
      },
      termination: 'unconfirmed',
    })
    emitProgress(onProgress, {
      action,
      phase: 'started',
    })
    const result = await this.call('mutate', signal)
    if (!isMutationResult(result, action)) {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.retainResult(result)
    const verified = await this.call('verify-mutation', signal)
    const mutation = this.current.mutation
    if (
      !mutation ||
      !mutation.returned ||
      !isMutationResult(verified, action) ||
      !sameJson(verified, mutation.returned)
    ) {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.persist({
      mutation: {
        ...mutation,
        verifiedAt: new Date().toISOString(),
      },
    })
    emitProgress(onProgress, {
      action,
      phase: 'verified',
    })
  }

  private async applyMutations(signal: AbortSignal, onProgress?: (event: MutationProgress) => void): Promise<void> {
    this.requireOpen()
    const approval = this.current.approval
    if (
      !approval ||
      this.current.accountId === null ||
      !isSpec(approval.permission, this.current.accountId, this.current.name)
    ) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    while (true) {
      const action = transitions.next(this.current)
      if (action === null) {
        return
      }
      await this.mutate(action, signal, onProgress)
    }
  }

  public async createOperator(signal: AbortSignal, onProgress?: (event: MutationProgress) => void): Promise<void> {
    if (this.current.kind !== 'onboard') {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    await this.applyMutations(signal, onProgress)
  }

  public async apply(signal: AbortSignal, onProgress?: (event: MutationProgress) => void): Promise<void> {
    if (this.current.kind !== 'maintain') {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    await this.applyMutations(signal, onProgress)
    await this.verify(null, signal)
  }

  private requireOperator(authentication: AwsAuthentication | null): void {
    if (this.current.kind !== 'onboard') {
      return
    }
    if (!authentication || !this.current.operator) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    requireAuthentication(authentication, this.current.operator)
  }

  public async readiness(authentication: AwsAuthentication, signal: AbortSignal): Promise<Readiness> {
    this.requireOpen()
    if (this.current.kind !== 'onboard') {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    this.requireOperator(authentication)
    const result = await this.call('readiness', signal)
    if (result.kind !== 'readiness') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    return {
      ...result.readiness,
    }
  }

  public async verify(authentication: AwsAuthentication | null, signal: AbortSignal): Promise<void> {
    this.requireOpen()
    this.requireOperator(authentication)
    const result = await this.call('verify', signal)
    if (
      result.kind !== 'verified' ||
      this.current.foundation === null ||
      !sameJson(result.policy, this.current.foundation)
    ) {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    this.requirePolicy(result.policy)
    const approval = this.current.approval
    if (!approval) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    await this.persist({
      verified: {
        version: approval.permission.version,
        policyVersion: result.policy.versionId,
        sha256: result.policy.sha256,
        verifiedAt: new Date().toISOString(),
      },
    })
  }

  private async cleanRoot(): Promise<void> {
    await lifecycle.cleanRoot(this.directory, this.current.id)
    this.rootCleaned = true
    await this.persist({
      cleanup: 'completed',
    })
  }

  public async complete(authentication: AwsAuthentication | null = null): Promise<AwsConnection> {
    this.requireOpen()
    if (!this.current.verified) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    this.requireOperator(authentication)
    await this.cleanRoot()
    this.requireOperator(authentication)
    const connection = await lifecycle.publish(this.directory, this.current)
    await lifecycle.removePending(this.directory, this.current)
    this.closed = true
    return connection
  }

  public async decline(): Promise<void> {
    this.requireOpen()
    if (this.current.approval !== null || this.current.mutation !== null) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    await this.cleanRoot()
    await lifecycle.removePending(this.directory, this.current)
    this.closed = true
  }

  /**
   * Approved or uncertain work retains its pending authority. Before approval,
   * confirmed cleanup can dispose of the record because no IAM intent existed.
   */
  public async fail(
    error: unknown,
    facts: readonly DiagnosticFact[] = [],
    operator: Pick<RecoveryOutcomes, 'cleanup' | 'journal'> = {
      cleanup: true,
      journal: true,
    },
  ): Promise<never> {
    const failure = diagnostic(error)
    const terminated = terminationConfirmed(error)
    let journaled = true
    try {
      await this.persist({
        failureCode: originalCode(failure),
        termination: terminated ? 'confirmed' : 'unconfirmed',
      })
    } catch {
      journaled = false
    }
    if (terminated && !this.rootCleaned) {
      try {
        await this.cleanRoot()
      } catch {
        this.rootCleaned = false
      }
    }
    try {
      await this.persist({
        failureCode: originalCode(failure),
        termination: terminated ? 'confirmed' : 'unconfirmed',
        cleanup: this.rootCleaned ? 'completed' : 'unconfirmed',
      })
    } catch {
      journaled = false
    }
    let disposed = false
    if (journaled && this.rootCleaned && this.current.approval === null) {
      try {
        await lifecycle.removePending(this.directory, this.current)
        disposed = true
        this.closed = true
      } catch {
        journaled = false
      }
    }
    throw iamRecovery(
      failure,
      {
        termination: terminated,
        cleanup: this.rootCleaned && operator.cleanup,
        journal: journaled && operator.journal,
      },
      [
        ...pendingFacts(this.current),
        [
          'Pending evidence',
          disposed
            ? 'removed after confirmed cleanup; no approval or IAM mutation intent existed'
            : 'retained or removal not confirmed; explicit recovery is required',
        ],
        ...facts,
      ],
      this.current.kind === 'maintain',
    )
  }
}
