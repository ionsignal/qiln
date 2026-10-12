import { randomUUID } from 'node:crypto'
import { InstallerError, type InstallerErrorCode } from '../../diagnostic/error'
import { checkCancellation } from '../../terminal/prompts'
import { request, type ChildEvidence } from '../child/request'
import {
  isEvidence,
  isReply,
  type Acknowledgment,
  type Evidence,
  type Request,
  type Result,
} from '../ec2/protocol'
import { diagnostic } from '../errors'
import { deploymentRecovery, originalCode, terminationConfirmed } from '../recovery'
import { AWS_SPEC } from '../spec'
import { validCidr, validSource } from './cidr'
import { deploymentFacts, removable } from './facts'
import * as records from './records'
import { stateOf } from './step'
import { allocate, creationPlan, expectation, ingressRules, matches, removalPlan, type Planned } from './topology'
import {
  isReceipt,
  requiredTags,
  type Deployment,
  type Failure,
  type FailureOutcome,
  type Observation,
  type Placement,
  type Step,
} from './types'
import type { Dir } from '../../state/files'
import type { Session } from '../auth/session'
import type { Certainty } from '../child/protocol'
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
    return 'not-attempted'
  }
  return error.code === 'AWS_DEPLOYMENT_BLOCKED' ? 'blocked' : 'rejected'
}

/**
 * Builds the deployment that the operator is asked to approve. Zones and the
 * administrator network are copied into the approval here, so the record alone
 * governs every later command. Callers gate on managed permission state first.
 */
export function propose(
  connection: AwsConnection,
  zones: readonly Placement[],
  administrator: string,
  alias: string,
): Deployment {
  const cidr = AWS_SPEC.deployment.defaultCidr
  if (!validCidr(cidr)) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
  if (!validSource(administrator)) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_INGRESS_INVALID',
      retry: `qiln aws deployment create --name ${connection.name} --alias ${alias}`,
    })
  }
  const managed = connection.managed
  if (!managed?.foundation || !managed.verified) {
    return invalid()
  }
  const id = randomUUID()
  const now = new Date().toISOString()
  return {
    version: 2,
    id,
    alias,
    connection: connection.name,
    binding: {
      accountId: connection.identity.accountId,
      operator: { ...connection.identity },
      creationId: managed.creationId,
      foundation: { ...managed.foundation },
      region: managed.permissionRegion,
    },
    approval: {
      approvedAt: now,
      approvedBy: { ...connection.identity },
      cidr,
      tenancy: 'default',
      zones: allocate(cidr, zones),
      ingress: ingressRules(administrator),
      tags: requiredTags(connection.identity.arn, id),
      permission: { ...managed.verified },
    },
    termination: 'confirmed',
    steps: [],
    removals: [],
    latest: null,
    createdAt: now,
  }
}

/**
 * Read-only discovery of the standard Availability Zones. There is no
 * deployment yet, so no record tracks this child: an unconfirmed termination
 * still retains the operation lock through its error.
 */
export async function placement(session: Session, signal: AbortSignal): Promise<Placement[]> {
  const input: Request = { kind: 'placement' }
  const reply = await request(AWS_SPEC.children.ec2, session.credentialEnvironment(), input, isReply, signal, {
    timeoutMs: AWS_SPEC.deployment.requestTimeoutMs,
  })
  if (!reply.ok) {
    throw new InstallerError({
      code: reply.code,
    })
  }
  if (reply.result.kind !== 'zones') {
    throw new InstallerError({
      code: 'AWS_CONTEXT_FAILED',
    })
  }
  return reply.result.zones
}

/**
 * Coordinates one deployment's provider work under the AWS-operation lock held
 * by the command. It owns the fence, the retention of returned evidence, and
 * the recovery report. Commands own approval presentation.
 */
export class Deployer {
  private fencedStepId: string | undefined

  private constructor(
    private readonly root: Dir,
    private readonly session: Session,
    private current: Deployment,
  ) {}

  public static open(root: Dir, session: Session, record: Deployment): Deployer {
    return new Deployer(root, session, record)
  }

  public static async approve(root: Dir, session: Session, proposal: Deployment): Promise<Deployer> {
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
    return new Deployer(root, session, record)
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
      timeoutMs: AWS_SPEC.deployment.requestTimeoutMs,
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
   * that step's response is retained but not yet verified. Observing never
   * triggers a mutation.
   */
  private async reconcile(observation: Observation): Promise<boolean> {
    const agrees = matches(expectation(this.current), observation)
    const last = this.current.steps.at(-1)
    const verifiesLast = agrees && last !== undefined && stateOf(last) === 'returned'
    await this.persist({
      latest: observation,
      ...(verifiesLast ? { steps: withLast(this.current.steps, { verifiedAt: observation.observedAt }) } : {}),
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
   * failure after a retained response, or an observation of an older open
   * step, changes only the termination evidence.
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
   */
  private async runStep(
    planned: Planned,
    removal: number | null,
    signal: AbortSignal,
    removalApproval: Partial<Deployment> = {},
  ): Promise<void> {
    checkCancellation(signal)
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
  }

  public async create(signal: AbortSignal): Promise<void> {
    this.requireReady()
    try {
      for (const planned of creationPlan(this.current.approval)) {
        await this.runStep(planned, null, signal)
      }
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
    let removalApproval: Partial<Deployment> = {
      latest: approved,
      removals: [...this.current.removals, { approvedAt: new Date().toISOString(), observation: approved }],
    }
    try {
      for (let next = removalPlan(this.current).at(0); next !== undefined; next = removalPlan(this.current).at(0)) {
        await this.runStep(next, attempt, signal, removalApproval)
        removalApproval = {}
      }
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }
}
