import { CapsuleOperationType, type CapsuleBlueprintRegistry, type CapsuleCreateReceipt } from '@qiln/core/server'
import { createOperationRequestHash } from '../shared'
import type { OperationSupervisor } from '../../../../coordination'
import type { CapsuleBranchEventPublisher } from '../../events/branch'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { CreateCapsuleExecutor } from './executor'
import type { CreateCapsuleOperationRepository } from './repository'
import type { SubmitCreateCapsuleInput } from './types'

interface CreateCapsuleRequestIdentity {
  operationType: typeof CapsuleOperationType.CREATE
  actor: SubmitCreateCapsuleInput['actor']
  rootBranchName: string
  blueprintName: string
  blueprintDigest: string
  cpu: string
  memory: string
}

/**
 * Accepts or replays capsule creation and schedules only newly accepted work.
 *
 * Mutable blueprint catalog state is consulted only after the repository has
 * confirmed that no durable idempotent replay exists. Once accepted, the
 * executor reloads the immutable blueprint snapshot from PostgreSQL.
 */
export class CreateCapsuleSubmissionService {
  constructor(
    private readonly repository: CreateCapsuleOperationRepository,
    private readonly executor: CreateCapsuleExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly blueprints: CapsuleBlueprintRegistry,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
    private readonly branchEvents: CapsuleBranchEventPublisher,
  ) {}

  public async submit(input: SubmitCreateCapsuleInput): Promise<CapsuleCreateReceipt> {
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.CREATE,
        actor: input.actor,
        rootBranchName: input.rootBranchName,
        blueprintName: input.blueprintName,
        blueprintDigest: input.blueprintDigest,
        cpu: input.cpu,
        memory: input.memory,
      } satisfies CreateCapsuleRequestIdentity,
      'capsule create request',
    )

    /**
     * This preflight is intentionally outside acceptance. A valid replay must
     * not depend on the mutable blueprint catalog still containing the original
     * definition.
     */
    const replay = await this.repository.findIdempotentReplay(
      input.ownerId,
      input.actor,
      input.idempotencyKey,
      requestHash,
    )

    if (replay) {
      return replay.receipt
    }

    const blueprintPin = this.blueprints.pin(input.blueprintName, input.blueprintDigest)

    /**
     * The repository repeats replay detection during acceptance so concurrent
     * submissions remain race-safe after the preflight lookup.
     */
    const acceptance = await this.repository.acceptCreate({
      ...input,
      requestHash,
      blueprintName: blueprintPin.name,
      blueprintDigest: blueprintPin.digest,
      blueprintSnapshot: blueprintPin.blueprint,
    })

    if (!acceptance.newlyAccepted) {
      return acceptance.receipt
    }

    // Ownership and state come from committed repository output rather than
    // from the original command input.
    this.operationEvents.publishChanged(acceptance.operation)
    this.lifecycleEvents.publishChanged(acceptance.operation.ownerId, acceptance.capsule)
    this.branchEvents.publishStateChanged(
      acceptance.operation.ownerId,
      acceptance.branch.capsuleId,
      acceptance.branch.name,
      acceptance.branch.status,
    )

    const operationId = acceptance.receipt.operationId
    const executor = this.executor

    // A false result leaves the durable operation accepted. The next Worker
    // startup will classify it without issuing provider mutations.
    this.supervisor.schedule(operationId, () => executor.execute(operationId))

    return acceptance.receipt
  }
}
