import { InstallerError, type DiagnosticFact } from '../../diagnostic/error'
import type { Dir } from '../../state/files'
import { checkCancellation } from '../../terminal/prompts'
import { request } from '../auth/child'
import { requireAuthentication } from '../auth/identity'
import { login, type AwsCli } from '../auth/login'
import { removeAuth, Session } from '../auth/session'
import { bootstrapRecovery, diagnostic, originalCode, terminationConfirmed, type RecoveryOutcomes } from '../errors'
import { AWS_SPEC } from '../spec'
import type { AwsAuthentication, LoginFlow } from '../types'
import { arn, canonical, name, POLICY, selfService } from './policy'
import * as state from './state'
import {
  isBootstrapReply,
  ready,
  type BootstrapAction,
  type BootstrapPhase,
  type BootstrapRecord,
  type BootstrapRequest,
  type BootstrapResult,
  type Proposal,
  type Readiness,
} from './types'

export class Bootstrap {
  private cleanupStarted = false
  private cleanupComplete = false

  private constructor(
    private readonly directory: Dir,
    private current: BootstrapRecord,
    private readonly session: Session,
  ) {}

  public static async create(connection: Dir, connectionName: string, region: string): Promise<Bootstrap> {
    const directory = await state.create(connection, connectionName, region)
    const record = await state.inspect(directory)
    try {
      const session = await Session.create(directory, region)
      return new Bootstrap(directory, record, session)
    } catch (error: unknown) {
      const failure = diagnostic(error)
      let cleanup = true
      try {
        await removeAuth(directory)
      } catch {
        cleanup = false
      }
      let journal = true
      try {
        await state.save(directory, {
          ...record,
          updatedAt: new Date().toISOString(),
          failureCode: originalCode(failure),
          cleanup: cleanup ? 'completed' : 'unconfirmed',
        })
      } catch {
        journal = false
      }
      throw bootstrapRecovery(
        failure,
        {
          termination: true,
          cleanup,
          journal,
        },
        state.facts(record),
      )
    }
  }

  public get record(): BootstrapRecord {
    return state.copy(this.current)
  }

  private requirePhase(...phases: BootstrapPhase[]): void {
    const expectedCleanup = this.current.phase === 'cleaned' || this.current.phase === 'saved' ? 'completed' : 'pending'
    if (
      this.current.failureCode !== null ||
      this.current.cleanup !== expectedCleanup ||
      this.current.termination !== 'confirmed' ||
      !phases.includes(this.current.phase)
    ) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_RECORDED',
        facts: state.facts(this.current),
      })
    }
  }

  private async persist(changes: Partial<BootstrapRecord>): Promise<void> {
    const next = state.parse({
      ...this.current,
      ...changes,
      updatedAt: new Date().toISOString(),
    })
    // A failed directory sync may occur after the rename. Retain the intended
    // in-memory record for recovery reporting instead of claiming no write.
    this.current = next
    await state.save(this.directory, next)
  }

  private async removeRoot(): Promise<void> {
    this.cleanupStarted = true
    await removeAuth(this.directory)
    this.cleanupComplete = true
  }

  /**
   * The command owns failure handling once both authentication subtrees are
   * involved. Bootstrap methods do not wrap each other's recovery failures.
   */
  public async fail(
    error: unknown,
    operator: Pick<RecoveryOutcomes, 'cleanup' | 'journal'> = {
      cleanup: true,
      journal: true,
    },
    facts: readonly DiagnosticFact[] = [],
  ): Promise<never> {
    const failure = diagnostic(error)
    const terminated = terminationConfirmed(error)
    if (terminated && !this.cleanupStarted) {
      try {
        await this.removeRoot()
      } catch {
        this.cleanupComplete = false
      }
    }
    let journal = true
    try {
      await this.persist({
        failureCode: originalCode(failure),
        termination: terminated ? 'confirmed' : 'unconfirmed',
        cleanup: this.cleanupComplete ? 'completed' : 'unconfirmed',
      })
    } catch {
      journal = false
    }
    throw bootstrapRecovery(
      failure,
      {
        termination: terminated,
        cleanup: this.cleanupComplete && operator.cleanup,
        journal: journal && operator.journal,
      },
      [
        ...state.facts(this.current),
        ['Root authentication cleanup', this.cleanupComplete ? 'completed' : 'not confirmed'],
        ['Bootstrap failure journal', journal ? 'persisted' : 'persistence not confirmed'],
        ...facts,
      ],
    )
  }

  private async call(action: BootstrapAction, phase: BootstrapPhase, signal: AbortSignal): Promise<BootstrapResult> {
    checkCancellation(signal)
    await this.persist({
      phase,
      termination: 'unconfirmed',
    })
    const input: BootstrapRequest = {
      kind: action,
      operationId: this.current.id,
      region: this.current.region,
    }
    const reply = await request(
      AWS_SPEC.bootstrap.processFile,
      this.session.environment(),
      input,
      isBootstrapReply,
      signal,
      {
        timeoutMs: AWS_SPEC.bootstrap.requestTimeoutMs,
        terminal: action === 'password',
      },
    )
    if (!reply.ok) {
      throw new InstallerError({
        code: reply.code,
      })
    }
    return reply.result
  }

  public async login(cli: AwsCli, flow: LoginFlow, signal: AbortSignal): Promise<void> {
    this.requirePhase('login')
    checkCancellation(signal)
    await this.persist({
      termination: 'unconfirmed',
    })
    await login(cli, this.session, flow, signal)
    await this.persist({
      termination: 'confirmed',
    })
  }

  public async inspect(signal: AbortSignal): Promise<void> {
    this.requirePhase('login', 'inspected')
    const result = await this.call('inspect', this.current.phase, signal)
    if (result.kind !== 'inspection') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.persist({
      phase: 'inspected',
      root: result.root,
      review: result.review,
      termination: 'confirmed',
    })
  }

  public proposal(): Proposal {
    this.requirePhase('inspected')
    const root = this.current.root
    const reviewed = this.current.review
    if (!root || !reviewed) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_STATE_INVALID',
      })
    }
    const operatorName = name(this.current.name)
    return {
      operationId: this.current.id,
      accountId: root.identity.accountId,
      operatorName,
      operatorArn: arn(root.identity.accountId, this.current.name),
      managedPolicyArn: POLICY.managedArn,
      managedPolicy: {
        ...reviewed,
      },
      inlinePolicyName: POLICY.inlineName,
      inlinePolicy: selfService(root.identity.accountId, this.current.name),
      mfaDeviceNames: [operatorName, `${operatorName}-<device-name>`],
      mutations: [
        'Create one dedicated IAM user with Qiln ownership tags.',
        'Attach the reviewed AWS-managed SignInLocalDevelopmentAccess policy.',
        'Add the displayed password and MFA self-service inline policy.',
        'Create one initial console password requiring replacement.',
        'Do not create access keys or grant infrastructure deployment access.',
      ],
    }
  }

  /**
   * The command layer must present this proposal and obtain explicit approval.
   * Re-derivation prevents caller-supplied permissions from replacing policy.
   */
  public async approve(approved: Proposal, signal: AbortSignal): Promise<void> {
    this.requirePhase('inspected')
    if (!this.current.root?.mfaConfigured) {
      throw new InstallerError({
        code: 'AWS_ROOT_MFA_REQUIRED',
      })
    }
    if (canonical(approved) !== canonical(this.proposal())) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
      })
    }
    checkCancellation(signal)
    await this.persist({
      phase: 'approved',
      approvedAt: new Date().toISOString(),
    })
  }

  public async createOperator(signal: AbortSignal): Promise<void> {
    this.requirePhase('approved')
    const created = await this.call('create', 'creating', signal)
    if (created.kind !== 'operator') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.persist({
      phase: 'created',
      operator: created.identity,
      termination: 'confirmed',
    })
    const attached = await this.call('attach', 'attaching', signal)
    if (attached.kind !== 'done' || attached.action !== 'attach') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.persist({
      phase: 'attached',
      termination: 'confirmed',
    })
    const granted = await this.call('grant', 'granting', signal)
    if (granted.kind !== 'done' || granted.action !== 'grant') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.persist({
      phase: 'granted',
      termination: 'confirmed',
    })
    const password = await this.call('password', 'password', signal)
    if (password.kind !== 'done' || password.action !== 'password') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    await this.persist({
      phase: 'handoff',
      termination: 'confirmed',
    })
  }

  /**
   * Supply authentication freshly obtained from the separate ordinary operator
   * Session. Root credentials are used only for the IAM readiness inspection.
   */
  public async verify(authentication: AwsAuthentication, signal: AbortSignal): Promise<Readiness> {
    this.requirePhase('handoff', 'ready')
    if (!this.current.operator) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_STATE_INVALID',
      })
    }
    requireAuthentication(authentication, this.current.operator)
    const result = await this.call('readiness', this.current.phase, signal)
    if (result.kind !== 'readiness') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    if (result.readiness.passwordResetRequired === null) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_READINESS_UNKNOWN',
      })
    }
    await this.persist({
      phase: ready(result.readiness) ? 'ready' : 'handoff',
      readiness: result.readiness,
      termination: 'confirmed',
    })
    return {
      ...result.readiness,
    }
  }

  public async clean(): Promise<void> {
    this.requirePhase('ready')
    await this.removeRoot()
    await this.persist({
      phase: 'cleaned',
      cleanup: 'completed',
      termination: 'confirmed',
    })
  }

  /**
   * The command saves the ordinary connection and its operation record first. A
   * failure here leaves those writes intact and requires explicit recovery.
   */
  public async complete(): Promise<void> {
    this.requirePhase('cleaned')
    await this.persist({
      phase: 'saved',
    })
  }
}
