import { randomUUID } from 'node:crypto'
import { AWS_RECORD_VERSION, AWS_SPEC } from '../spec'
import { validCidr, validSource } from './cidr'
import { expectation, matches } from './expect'
import { deploymentFacts, removable } from './facts'
import { notify, withWaiting, type Place, type ProgressSink, type ProgressTask } from './progress'
import { stateOf } from './step'
import { creationPlan, removalPlan, type Planned } from './topology'
import {
  hostKeyName,
  isReceipt,
  requiredTags,
  type Deployment,
  type Failure,
  type FailureOutcome,
  type Health,
  type Observation,
  type Step,
} from './types'
import {
  isEvidence,
  isReply,
  requestDeadlineMs,
  type Acknowledgment,
  type Evidence,
  type Request,
  type Result,
} from '../ec2/protocol'
import { diagnostic } from '../errors'
import { generateAdminKey } from '../ssh/generate'
import { deploymentRecovery, originalCode, terminationConfirmed } from '../recovery'
import { InstallerError, type InstallerErrorCode } from '../../diagnostic/error'
import { checkCancellation } from '../../terminal/prompts'
import { request, type ChildEvidence } from '../child/request'
import * as records from './records'
import type { Dir } from '../../state/files'
import type { Session } from '../auth/session'
import type { Certainty } from '../child/protocol'
import type { HostPlan } from './host/types'
import type { AwsConnection } from '../types'

/**
 * A reply from the EC2 child. The certainty is kept so the fence can record a
 * definite refusal differently from an unknown outcome.
 */
class ChildFailure extends InstallerError {
  constructor(
    code: InstallerErrorCode,
    public readonly certainty: Certainty,
  ) {
    super({ code })
  }
}

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_STATE_INVALID',
  })
}

function withLast(steps: readonly Step[], change: Partial<Step>): Step[] {
  const last = steps[steps.length - 1]
  return [...steps.slice(0, -1), { ...last, ...change }]
}

function outcomeOf(error: InstallerError): FailureOutcome {
  if (!(error instanceof ChildFailure) || error.certainty !== 'rejected') {
    return 'uncertain'
  }
  if (error.code === 'AWS_DEPLOYMENT_NOT_ATTEMPTED') {
    return 'unattempted'
  }
  return error.code === 'AWS_DEPLOYMENT_BLOCKED' ? 'blocked' : 'rejected'
}

/**
 * Builds the deployment that the operator is asked to approve. The approval is
 * copied from one frozen host plan, so the zones, administrator network, and
 * launch configuration the operator reviewed are the ones the record governs.
 * A plan exists only when nothing blocked the proposal. The idempotency tokens
 * are generated once, here, and are never regenerated for a retry. The
 * administrative key is generated after approval, so the proposal has none.
 * Callers gate on managed permission state first. Deployments bind only the
 * foundation policy, which every managed connection has enrolled.
 */
export function propose(connection: AwsConnection, plan: HostPlan, alias: string): Deployment {
  if (!validCidr(plan.cidr)) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
  if (!validSource(plan.ingress[0].cidr)) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_INGRESS_INVALID',
      retry: `qiln aws deployment create --name ${connection.name} --alias ${alias}`,
    })
  }
  const managed = connection.managed
  if (!managed || plan.region !== managed.deploymentRegion) {
    return invalid()
  }
  const id = randomUUID()
  const now = new Date().toISOString()
  return {
    id,
    alias,
    version: AWS_RECORD_VERSION.deployment,
    connection: connection.name,
    binding: {
      accountId: connection.identity.accountId,
      operator: { ...connection.identity },
      creationId: managed.creationId,
      foundation: { ...managed.policies.foundation },
      region: managed.deploymentRegion,
    },
    approval: {
      approvedAt: now,
      approvedBy: { ...connection.identity },
      cidr: plan.cidr,
      tenancy: 'default',
      zones: structuredClone(plan.zones),
      ingress: structuredClone(plan.ingress),
      tags: requiredTags(connection.identity.arn, id),
      permission: structuredClone(managed.verified),
      host: {
        plan: structuredClone(plan),
        keyName: hostKeyName(id),
        launchToken: randomUUID(),
        volumeToken: randomUUID(),
      },
    },
    key: null,
    termination: 'confirmed',
    steps: [],
    removals: [],
    implicit: null,
    latest: null,
    health: null,
    createdAt: now,
  }
}

/**
 * Coordinates one deployment's provider work under the AWS-operation lock held
 * by the command. It owns the fence, the retention of returned evidence, and
 * the recovery report. Commands own approval presentation and progress
 * rendering; the optional progress sink only observes and never decides an
 * outcome.
 */
export class Deployer {
  private fencedStepId: string | undefined

  private constructor(
    private readonly root: Dir,
    private readonly session: Session,
    private current: Deployment,
    private readonly progress?: ProgressSink,
  ) {}

  public static open(root: Dir, session: Session, record: Deployment, progress?: ProgressSink): Deployer {
    return new Deployer(root, session, record, progress)
  }

  public static async approve(
    root: Dir,
    session: Session,
    proposal: Deployment,
    progress?: ProgressSink,
  ): Promise<Deployer> {
    const approvedAt = new Date().toISOString()
    const record: Deployment = {
      ...proposal,
      approval: {
        ...proposal.approval,
        approvedAt,
      },
      createdAt: approvedAt,
    }
    await records.create(root, record)
    return new Deployer(root, session, record, progress)
  }

  public get record(): Deployment {
    return structuredClone(this.current)
  }

  private get retry(): string {
    return `qiln aws deployment status --id ${this.current.id}`
  }

  private requireReady(): void {
    if (this.current.termination !== 'confirmed') {
      throw new InstallerError({
        code: 'AWS_DEPLOYMENT_RECOVERY_REQUIRED',
        facts: deploymentFacts(this.current),
        retry: this.retry,
      })
    }
  }

  /**
   * Creation is fresh-only. A record with any key, execution history, or removal
   * history is never continued, replayed, or given another key. Refusing here,
   * before any state change, keeps this command from touching the record.
   */
  private requireFresh(): void {
    const { steps, removals, key } = this.current
    if (steps.length !== 0 || removals.length !== 0 || key !== null) {
      throw new InstallerError({
        code: 'AWS_DEPLOYMENT_CREATE_REFUSED',
        facts: deploymentFacts(this.current),
        retry: this.retry,
      })
    }
  }

  /**
   * Local work runs under the same unconfirmed-termination fence as provider
   * work. The binding is persisted only after the pair validated, so a failure
   * leaves the key directory without a binding: evidence that blocks any
   * later generation rather than something Qiln repairs.
   */
  private async generateKey(signal: AbortSignal): Promise<void> {
    const task: ProgressTask = { kind: 'key' }
    notify(this.progress, { phase: 'working', task })
    await this.persist({
      termination: 'unconfirmed',
    })
    const directory = await records.directoryOf(this.root, this.current.id)
    const key = await generateAdminKey(directory, this.current.id, signal)
    await this.persist({
      key,
      termination: 'confirmed',
    })
    notify(this.progress, { phase: 'verified', task })
  }

  private async persist(changes: Partial<Deployment>): Promise<void> {
    const updated = records.parse({
      ...this.current,
      ...changes,
    })
    // A rename can precede a failed directory sync. Retain the intended record
    // for recovery reporting without claiming that persistence succeeded.
    this.current = updated
    await records.save(this.root, updated)
  }

  /**
   * The child may reply only after the response is durably retained here, so the
   * message must belong to the open step and carry an identity of the right shape.
   */
  private evidence(step: Step): ChildEvidence {
    const owns = (message: unknown): message is Evidence =>
      isEvidence(message) && message.deploymentId === this.current.id && message.operationId === step.id
    return {
      accept: owns,
      retain: async message => {
        if (!owns(message) || !isReceipt(step.action, message.resourceId)) {
          throw new InstallerError({
            code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
          })
        }
        await this.persist({
          steps: withLast(this.current.steps, {
            returned: {
              returnedAt: message.returnedAt,
              resourceId: message.resourceId,
            },
          }),
        })
        const acknowledgment: Acknowledgment = {
          kind: 'evidence-retained',
          deploymentId: message.deploymentId,
          operationId: message.operationId,
        }
        return acknowledgment
      },
    }
  }

  private async call(input: Request, signal: AbortSignal, evidence?: ChildEvidence): Promise<Result> {
    if (this.current.termination === 'confirmed') {
      await this.persist({
        termination: 'unconfirmed',
      })
    }
    const reply = await request(AWS_SPEC.children.ec2, this.session.credentialEnvironment(), input, isReply, signal, {
      timeoutMs: requestDeadlineMs(input),
      evidence,
    })
    await this.persist({
      termination: 'confirmed',
    })
    if (!reply.ok) {
      throw new ChildFailure(reply.code, reply.certainty)
    }
    return reply.result
  }

  private async observation(wait: boolean, signal: AbortSignal): Promise<Observation> {
    const result = await this.call(
      {
        kind: 'observe',
        deploymentId: this.current.id,
        wait,
      },
      signal,
    )
    if (result.kind !== 'observation') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    return result.observation
  }

  /**
   * Retains the observation as the latest one. An observation that agrees with
   * the ledger is positive evidence, so it also verifies the newest step when
   * that step's response is retained but not yet verified. The first agreeing
   * observation of a launched instance also supplies the root volume and
   * interface that AWS created with it, in the same write that verifies the
   * launch. Observing never triggers a mutation.
   */
  private async reconcile(observation: Observation): Promise<boolean> {
    const agrees = matches(expectation(this.current), observation)
    const last = this.current.steps.at(-1)
    const verifiesLast = agrees && last !== undefined && stateOf(last) === 'returned'
    const discovered = agrees && this.current.implicit === null ? observation.implicit : null
    await this.persist({
      latest: observation,
      ...(verifiesLast ? { steps: withLast(this.current.steps, { verifiedAt: observation.observedAt }) } : {}),
      ...(discovered === null ? {} : { implicit: { ...discovered, observedAt: observation.observedAt } }),
    })
    return agrees
  }

  private async verify(signal: AbortSignal): Promise<void> {
    if (!(await this.reconcile(await this.observation(true, signal)))) {
      throw new InstallerError({
        code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
      })
    }
  }

  /**
   * A failure is recorded only on the step this instance fenced, and only while
   * it is open. Any other failure, such as a verification or observation
   * failure after a retained response, or a health failure after the last
   * step was verified, changes only the termination evidence.
   */
  private async close(failure: InstallerError, confirmed: boolean): Promise<void> {
    const termination: Deployment['termination'] = confirmed ? 'confirmed' : 'unconfirmed'
    const { steps } = this.current
    const last = steps.at(-1)
    if (last === undefined || last.id !== this.fencedStepId || stateOf(last) !== 'open') {
      await this.persist({
        termination,
      })
      return
    }
    const closed: Failure = {
      outcome: outcomeOf(failure),
      code: originalCode(failure),
      termination,
      recordedAt: new Date().toISOString(),
    }
    await this.persist({
      termination,
      steps: withLast(steps, { failure: closed }),
    })
  }

  private async fail(error: unknown): Promise<never> {
    const terminated = terminationConfirmed(error)
    const failure = diagnostic(error)
    let persisted = true
    try {
      await this.close(failure, terminated)
    } catch {
      persisted = false
    }
    throw deploymentRecovery(
      failure,
      {
        termination: terminated,
        persistence: persisted,
      },
      deploymentFacts(this.current),
      this.retry,
    )
  }

  /**
   * One fenced provider call, then its bounded verification. `removalApproval`
   * carries a new removal approval together with the first deletion step.
   * `verified` is announced only after the verifying observation is persisted.
   */
  private async runStep(
    planned: Planned,
    removal: number | null,
    signal: AbortSignal,
    place: Place,
    removalApproval: Partial<Deployment> = {},
  ): Promise<void> {
    checkCancellation(signal)
    const task: ProgressTask = { kind: 'step', action: planned.action, slot: planned.slot, ...place }
    notify(this.progress, { phase: 'working', task })
    const step: Step = {
      id: randomUUID(),
      action: planned.action,
      slot: planned.slot,
      removal,
      fencedAt: new Date().toISOString(),
      returned: null,
      failure: null,
      verifiedAt: null,
    }
    this.fencedStepId = step.id
    await this.persist({
      ...removalApproval,
      termination: 'unconfirmed',
      steps: [...this.current.steps, step],
    })
    await withWaiting(this.progress, task, async () => {
      const result = await this.call(
        {
          kind: 'mutate',
          deploymentId: this.current.id,
          operationId: step.id,
        },
        signal,
        this.evidence(step),
      )
      const returned = this.current.steps.at(-1)?.returned
      if (result.kind !== 'done' || !returned || returned.resourceId !== result.resourceId) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
        })
      }
      await this.verify(signal)
    })
    notify(this.progress, { phase: 'verified', task })
  }

  /**
   * One read-only AWS health read, not a ledger step: it has no fence, receipt,
   * or removal. Only a passing read is retained, in a write that changes
   * nothing else. With `wait` an exhausted budget is an error; without it a
   * non-passing read returns null and records nothing.
   */
  private async recordHealth(wait: boolean, signal: AbortSignal): Promise<Health | null> {
    checkCancellation(signal)
    const task: ProgressTask = { kind: 'health' }
    notify(this.progress, { phase: 'working', task })
    const result = await withWaiting(this.progress, task, () =>
      this.call(
        {
          kind: 'health',
          deploymentId: this.current.id,
          wait,
        },
        signal,
      ),
    )
    if (result.kind !== 'health') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    if (result.health === null) {
      return null
    }
    await this.persist({
      health: result.health,
    })
    notify(this.progress, { phase: 'verified', task })
    return result.health
  }

  public async create(signal: AbortSignal): Promise<void> {
    this.requireReady()
    this.requireFresh()
    try {
      await this.generateKey(signal)
      const plan = creationPlan(this.current.approval)
      for (const [index, planned] of plan.entries()) {
        await this.runStep(planned, null, signal, { position: index + 1, total: plan.length })
      }
      await this.recordHealth(true, signal)
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }

  /**
   * One non-polling health read of a fully created deployment. Used to retain
   * health evidence after a creation whose wait was exhausted.
   */
  public async health(signal: AbortSignal): Promise<Health | null> {
    this.requireReady()
    try {
      return await this.recordHealth(false, signal)
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }

  public async observe(signal: AbortSignal): Promise<Observation> {
    this.requireReady()
    try {
      const observation = await this.observation(false, signal)
      await this.reconcile(observation)
      return observation
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }

  public async candidates(signal: AbortSignal): Promise<Observation[]> {
    this.requireReady()
    try {
      const result = await this.call(
        {
          kind: 'candidates',
          deploymentId: this.current.id,
        },
        signal,
      )
      if (result.kind !== 'candidates') {
        throw new InstallerError({
          code: 'AWS_CONTEXT_FAILED',
        })
      }
      return result.candidates
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }

  /**
   * Call only after the operator approved removal of the displayed fresh
   * observation. Runs the ledger-derived removal plan serially, one fenced
   * deletion at a time, and stops at the first refused or uncertain step.
   * AWS refusal is the only dependency gate.
   */
  public async remove(approved: Observation, signal: AbortSignal): Promise<void> {
    this.requireReady()
    if (!removable(this.current) || !matches(expectation(this.current), approved)) {
      throw new InstallerError({
        code: 'AWS_DEPLOYMENT_REMOVAL_REFUSED',
        facts: deploymentFacts(this.current),
        retry: this.retry,
      })
    }
    const attempt = this.current.removals.length
    const total = removalPlan(this.current).length
    let position = 0
    let removalApproval: Partial<Deployment> = {
      latest: approved,
      removals: [...this.current.removals, { approvedAt: new Date().toISOString(), observation: approved }],
    }
    try {
      for (let next = removalPlan(this.current).at(0); next !== undefined; next = removalPlan(this.current).at(0)) {
        position += 1
        await this.runStep(next, attempt, signal, { position, total }, removalApproval)
        removalApproval = {}
      }
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }
}
