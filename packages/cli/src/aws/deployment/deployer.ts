import { randomUUID } from 'node:crypto'
import { AWS_RECORD_VERSION, AWS_SPEC } from '../spec'
import { validCidr, validSource } from './cidr'
import { expectation, matches } from './expect'
import { deploymentFacts, removable } from './facts'
import { declined, stateOf } from './step'
import { diagnostic } from '../errors'
import { accept } from '../primitives'
import { generateAdminKey } from '../ssh/generate'
import { checkCancellation } from '../../terminal/prompts'
import { request, type ChildEvidence } from '../child/request'
import { creationPlan, removalPlan, type Planned } from './topology'
import { deploymentRecovery, originalCode, terminationConfirmed } from '../recovery'
import { InstallerError, type InstallerErrorCode } from '../../diagnostic/error'
import { notify, withWaiting, type Place, type ProgressSink, type StepTask } from './progress'
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
  evidenceSchema,
  replySchema,
  requestDeadlineMs,
  type Acknowledgment,
  type Evidence,
  type Request,
  type Result,
} from '../ec2/protocol'
import * as records from './records'
import type { Dir } from '../../state/files'
import type { Session } from '../auth/session'
import type { Certainty } from '../child/protocol'
import type { HostKey } from './hostkey'
import type { HostPlan } from './host/types'
import type { Reuse } from './reuse'
import type { AwsConnection } from '../types'

/**
 * The outcome of one call. The certainty is kept so the fence can record a
 * definite refusal differently from an unknown outcome. It comes from the EC2
 * child's reply, or from a call that was cancelled before any child started.
 */
class CallFailure extends InstallerError {
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

function stepTask(planned: Planned, place: Place): StepTask {
  return { kind: 'step', action: planned.action, slot: planned.slot, ...place }
}

function outcomeOf(error: InstallerError): FailureOutcome {
  if (!(error instanceof CallFailure) || error.certainty !== 'rejected') {
    return 'uncertain'
  }
  if (error.code === 'AWS_DEPLOYMENT_NOT_ATTEMPTED' || error.code === 'COMMAND_CANCELLED') {
    return 'unattempted'
  }
  return error.code === 'AWS_DEPLOYMENT_BLOCKED' ? 'blocked' : 'rejected'
}

/**
 * Builds the deployment that the operator is asked to approve. The approval is
 * copied from one frozen host plan, so the zones, administrator network, and
 * launch configuration the operator reviewed are the ones the record governs.
 * A plan exists only when nothing blocked the proposal. The idempotency tokens
 * are generated once, here, one per launch candidate, and are never
 * regenerated for a retry. The administrative key is generated after approval,
 * so the proposal has none.
 * `previous` is the immutable ID of the deployment whose alias this one takes
 * over. A `reuse` attaches that deployment's retained data volume by identity,
 * with its original tags, instead of creating a new one; it must come from
 * `previous`. Callers gate on managed permission state first. Deployments bind
 * only the foundation policy, which every managed connection has enrolled.
 */
export function propose(
  connection: AwsConnection,
  plan: HostPlan,
  alias: string,
  previous: string | null,
  reuse: Reuse | null,
): Deployment {
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
    previous,
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
        launchTokens: plan.hostSlots.map(() => randomUUID()),
        volume:
          reuse === null
            ? { kind: 'new', token: randomUUID() }
            : { kind: 'reuse', from: reuse.from, volumeId: reuse.volumeId, tags: structuredClone(reuse.tags) },
      },
    },
    adminKey: null,
    hostKey: null,
    termination: 'confirmed',
    steps: [],
    removals: [],
    implicit: null,
    latest: null,
    health: null,
    handoff: null,
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
    const { steps, removals, adminKey } = this.current
    if (steps.length !== 0 || removals.length !== 0 || adminKey !== null) {
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
    const task = { kind: 'key' } as const
    notify(this.progress, { phase: 'working', task })
    await this.persist({
      termination: 'unconfirmed',
    })
    const directory = await records.directoryOf(this.root, this.current.id)
    const adminKey = await generateAdminKey(directory, this.current.id, signal)
    await this.persist({
      adminKey,
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
   * The evidence a child message carries, or null unless it is well-formed and
   * belongs to the open step of this deployment.
   */
  private ownedEvidence(message: unknown, step: Step): Evidence | null {
    const evidence = accept(evidenceSchema, message)
    return evidence?.deploymentId === this.current.id && evidence.operationId === step.id ? evidence : null
  }

  /**
   * The child may reply only after the response is durably retained here, so the
   * message must belong to the open step and carry an identity of the right shape.
   */
  private evidence(step: Step): ChildEvidence {
    return {
      accept: message => this.ownedEvidence(message, step) !== null,
      retain: async message => {
        const evidence = this.ownedEvidence(message, step)
        if (evidence === null || !isReceipt(step.action, evidence.resourceId)) {
          throw new InstallerError({
            code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
          })
        }
        await this.persist({
          steps: withLast(this.current.steps, {
            returned: {
              returnedAt: evidence.returnedAt,
              resourceId: evidence.resourceId,
            },
          }),
        })
        const acknowledgment: Acknowledgment = {
          kind: 'evidence-retained',
          deploymentId: evidence.deploymentId,
          operationId: evidence.operationId,
        }
        return acknowledgment
      },
    }
  }

  /**
   * A call cancelled before it starts never reaches a child, so a fenced step
   * is definitely unattempted. A mutating reply that arrived before cancellation
   * is kept and recorded first, and the cancellation is honored by the next call.
   */
  private async call(input: Request, signal: AbortSignal, evidence?: ChildEvidence): Promise<Result> {
    if (signal.aborted) {
      throw new CallFailure('COMMAND_CANCELLED', 'rejected')
    }
    if (this.current.termination === 'confirmed') {
      await this.persist({
        termination: 'unconfirmed',
      })
    }
    const reply = await request(AWS_SPEC.children.ec2, this.session.credentialEnvironment(), input, replySchema, signal, {
      timeoutMs: requestDeadlineMs(input),
      evidence,
      keepReply: input.kind === 'mutate',
    })
    await this.persist({
      termination: 'confirmed',
    })
    if (!reply.ok) {
      throw new CallFailure(reply.code, reply.certainty)
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
    const task = stepTask(planned, place)
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
   * Whether this failure is a definite capacity refusal that is now durably
   * recorded on the launch attempt. Only that failure may move on to the next
   * approved zone. The child reply that carries it also ended the child, so
   * termination is confirmed, and anything uncertain, cancelled, or already
   * past a returned response is never a decline. `AWS_DEPLOYMENT_CAPACITY` must
   * stay exclusive to the child's `InsufficientInstanceCapacity` mapping.
   */
  private async recordDeclined(error: unknown): Promise<boolean> {
    if (
      !(error instanceof CallFailure) ||
      error.code !== 'AWS_DEPLOYMENT_CAPACITY' ||
      error.certainty !== 'rejected' ||
      !terminationConfirmed(error)
    ) {
      return false
    }
    try {
      await this.close(error, true)
    } catch {
      return false
    }
    const last = this.current.steps.at(-1)
    return last !== undefined && declined(last)
  }

  /**
   * Tries each approved zone once, in order, stopping at the first attempt that
   * returns. When the attempt succeeds, any verification failure ends creation
   * as before. The last approved zone is never retried, and its refusal is
   * recorded by the ordinary failure path.
   */
  private async launch(planned: Planned, signal: AbortSignal, place: Place): Promise<void> {
    const { hostSlots, zones } = this.current.approval.host.plan
    for (const [index, slot] of hostSlots.entries()) {
      const attempt: Place = {
        ...place,
        attempt: { number: index + 1, total: hostSlots.length, zone: zones[slot].name },
      }
      try {
        await this.runStep(planned, null, signal, attempt)
        return
      } catch (error: unknown) {
        if (index + 1 === hostSlots.length || !(await this.recordDeclined(error))) {
          throw error
        }
        notify(this.progress, { phase: 'declined', task: stepTask(planned, attempt) })
      }
    }
  }

  /**
   * One read-only AWS health read, not a ledger step: it has no fence, receipt,
   * or removal. Only a passing read is retained, in a write that changes
   * nothing else. With `wait` an exhausted budget is an error; without it a
   * non-passing read returns null and records nothing.
   */
  private async recordHealth(wait: boolean, signal: AbortSignal): Promise<Health | null> {
    checkCancellation(signal)
    const task = { kind: 'health' } as const
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
        const place = { position: index + 1, total: plan.length }
        if (planned.action === 'run-instances') {
          await this.launch(planned, signal, place)
        } else {
          await this.runStep(planned, null, signal, place)
        }
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

  /**
   * Retains the server's Ed25519 host key as the pin for later SSH handshakes.
   * Like health, it is a read-only AWS read rather than a ledger step: it has no
   * fence, receipt, or removal, and the pin is retained in a write that changes
   * nothing else. The evidence is AWS-reported console output, not guest
   * attestation. An exhausted wait is an error that records nothing.
   */
  public async hostKey(signal: AbortSignal): Promise<HostKey> {
    this.requireReady()
    try {
      checkCancellation(signal)
      const task = { kind: 'hostkey' } as const
      notify(this.progress, { phase: 'working', task })
      const result = await withWaiting(this.progress, task, () =>
        this.call(
          {
            kind: 'hostkey',
            deploymentId: this.current.id,
          },
          signal,
        ),
      )
      if (result.kind !== 'hostkey') {
        throw new InstallerError({
          code: 'AWS_CONTEXT_FAILED',
        })
      }
      await this.persist({
        hostKey: result.hostKey,
      })
      notify(this.progress, { phase: 'verified', task })
      return result.hostKey
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
