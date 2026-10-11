import { randomUUID } from 'node:crypto'
import { InstallerError, type InstallerErrorCode } from '../../diagnostic/error'
import type { Dir } from '../../state/files'
import { checkCancellation } from '../../terminal/prompts'
import type { Session } from '../auth/session'
import type { Certainty } from '../child/protocol'
import { request, type ChildEvidence } from '../child/request'
import {
  isEvidence,
  isReply,
  type Acknowledgment,
  type Evidence,
  type Request,
  type Result,
  type Until,
} from '../ec2/protocol'
import { diagnostic } from '../errors'
import { deploymentRecovery, originalCode, terminationConfirmed } from '../recovery'
import { AWS_SPEC } from '../spec'
import type { AwsConnection } from '../types'
import { validCidr } from './cidr'
import { deploymentFacts, removable } from './facts'
import * as records from './records'
import {
  requiredTags,
  verifies,
  type Deployment,
  type Failure,
  type FailureOutcome,
  type Fenced,
  type Observation,
} from './types'

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

function isOpen(fence: Fenced): boolean {
  return fence.returned === null && fence.failure === null
}

/** Only a definite provider refusal is recorded as one. Everything else keeps the effect open. */
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
 * Builds the deployment that the operator is asked to approve. The CIDR is
 * copied into the approval here, so the record alone governs every later
 * command. Callers gate on managed permission state before proposing.
 */
export function propose(connection: AwsConnection, cidr: string): Deployment {
  if (!validCidr(cidr)) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
  const managed = connection.managed
  if (!managed?.foundation || !managed.verified) {
    return invalid()
  }
  const id = randomUUID()
  const now = new Date().toISOString()
  return {
    version: 1,
    id,
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
      tags: requiredTags(connection.identity.arn, id),
      permission: { ...managed.verified },
    },
    termination: 'confirmed',
    creation: null,
    removals: [],
    latest: null,
    verified: null,
    createdAt: now,
  }
}

/**
 * Coordinates one deployment's provider work under the AWS-operation lock held
 * by the command. It owns the fence, the retention of returned evidence, and
 * the recovery report. Commands own approval presentation.
 */
export class Deployer {
  private constructor(
    private readonly root: Dir,
    private readonly session: Session,
    private current: Deployment,
  ) {}

  public static open(root: Dir, session: Session, record: Deployment): Deployer {
    return new Deployer(root, session, record)
  }

  /** Persists the approval. Nothing is fenced and no provider call is made. */
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

  /** Unconfirmed termination is sticky: no further provider work runs until it is resolved. */
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

  private returned(evidence: Evidence): Partial<Deployment> {
    const { creation, removals } = this.current
    if (evidence.kind === 'vpc-created') {
      if (creation === null) {
        return invalid()
      }
      return {
        creation: {
          ...creation,
          returned: {
            vpcId: evidence.vpcId,
            returnedAt: evidence.returnedAt,
          },
        },
      }
    }
    const removal = removals.at(-1)
    if (removal === undefined) {
      return invalid()
    }
    return {
      removals: [
        ...removals.slice(0, -1),
        {
          ...removal,
          returned: {
            returnedAt: evidence.returnedAt,
          },
        },
      ],
    }
  }

  /**
   * The child may reply only after the response is durably retained here, so the
   * message must belong to the open fence and to the expected call.
   */
  private evidence(kind: Evidence['kind'], operationId: string): ChildEvidence {
    const matches = (message: unknown): message is Evidence =>
      isEvidence(message) &&
      message.kind === kind &&
      message.deploymentId === this.current.id &&
      message.operationId === operationId
    return {
      accept: matches,
      retain: async message => {
        if (!matches(message)) {
          throw new InstallerError({
            code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
          })
        }
        await this.persist(this.returned(message))
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

  /**
   * Retains the latest observation and sets `verified` once, the first time an
   * observation shows the approved VPC available and unchanged.
   */
  private async observeUntil(until: Until, signal: AbortSignal): Promise<Observation> {
    const result = await this.call(
      {
        kind: 'observe',
        deploymentId: this.current.id,
        until,
      },
      signal,
    )
    if (result.kind !== 'observation') {
      throw new InstallerError({
        code: 'AWS_CONTEXT_FAILED',
      })
    }
    const observation = result.observation
    await this.persist({
      latest: observation,
      verified: this.current.verified ?? (verifies(observation, this.current) ? observation : null),
    })
    return observation
  }

  /**
   * A failure is recorded on a fence only while it is open and no response is
   * retained. Verification or observation failures after a retained response
   * change only the termination evidence.
   */
  private async close(failure: InstallerError, confirmed: boolean): Promise<void> {
    const termination: Deployment['termination'] = confirmed ? 'confirmed' : 'unconfirmed'
    const { creation, removals } = this.current
    const removal = removals.at(-1)
    const closed: Failure = {
      outcome: outcomeOf(failure),
      code: originalCode(failure),
      termination,
      recordedAt: new Date().toISOString(),
    }
    if (removal !== undefined && isOpen(removal)) {
      await this.persist({
        termination,
        removals: [...removals.slice(0, -1), { ...removal, failure: closed }],
      })
      return
    }
    if (removal === undefined && creation !== null && isOpen(creation)) {
      await this.persist({
        termination,
        creation: { ...creation, failure: closed },
      })
      return
    }
    await this.persist({
      termination,
    })
  }

  private async fail(error: unknown): Promise<never> {
    // Termination evidence lives on the original error, so read it first.
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

  /** Fences one creation, calls `CreateVpc` once, then verifies by bounded observation. */
  public async create(signal: AbortSignal): Promise<void> {
    this.requireReady()
    checkCancellation(signal)
    const operationId = randomUUID()
    try {
      await this.persist({
        termination: 'unconfirmed',
        creation: {
          id: operationId,
          fencedAt: new Date().toISOString(),
          returned: null,
          failure: null,
        },
      })
      const result = await this.call(
        {
          kind: 'create',
          deploymentId: this.current.id,
          operationId,
        },
        signal,
        this.evidence('vpc-created', operationId),
      )
      if (result.kind !== 'created' || this.current.creation?.returned?.vpcId !== result.vpcId) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
        })
      }
      const observation = await this.observeUntil('available', signal)
      if (!verifies(observation, this.current)) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_VERIFICATION_FAILED',
        })
      }
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }

  /** One fresh observation of the recorded VPC, retained as the latest. */
  public async observe(signal: AbortSignal): Promise<Observation> {
    this.requireReady()
    try {
      return await this.observeUntil('any', signal)
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }

  /** Display only. Candidates are never adopted, and an empty result proves nothing. */
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
   * observation. Fences one removal, calls `DeleteVpc` once, then observes
   * absence. AWS refusal is the only dependency gate.
   */
  public async remove(approved: Observation, signal: AbortSignal): Promise<void> {
    this.requireReady()
    if (!removable(this.current) || !verifies(approved, this.current)) {
      throw new InstallerError({
        code: 'AWS_DEPLOYMENT_REMOVAL_REFUSED',
        facts: deploymentFacts(this.current),
        retry: this.retry,
      })
    }
    checkCancellation(signal)
    const operationId = randomUUID()
    const now = new Date().toISOString()
    try {
      await this.persist({
        latest: approved,
        termination: 'unconfirmed',
        removals: [
          ...this.current.removals,
          {
            id: operationId,
            approval: {
              approvedAt: now,
              observation: approved,
            },
            fencedAt: now,
            returned: null,
            failure: null,
          },
        ],
      })
      const result = await this.call(
        {
          kind: 'delete',
          deploymentId: this.current.id,
          operationId,
        },
        signal,
        this.evidence('vpc-deleted', operationId),
      )
      if (result.kind !== 'deleted' || this.current.removals.at(-1)?.returned == null) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
        })
      }
      await this.observeUntil('absent', signal)
    } catch (error: unknown) {
      return await this.fail(error)
    }
  }
}
