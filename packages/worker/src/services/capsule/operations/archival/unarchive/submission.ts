import { CapsuleOperationType, type CapsuleUnarchiveReceipt } from '@qiln/core/server'
import { createOperationRequestHash } from '../../shared'
import type { OperationSupervisor } from '../../../../../coordination'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { CapsuleUnarchiveExecutor } from './executor'
import type { CapsuleUnarchiveRepository } from './repository'
import type { SubmitUnarchiveCapsuleInput } from './types'

interface UnarchiveCapsuleRequestIdentity {
  operationType: typeof CapsuleOperationType.UNARCHIVE
  capsuleId: string
}

/**
 * Accepts or replays unarchive operations and schedules only newly accepted
 * work.
 *
 * Unarchive has no mutable catalog dependency between replay detection and
 * durable acceptance. Its complete race-safe replay protocol therefore belongs
 * to `CapsuleUnarchiveRepository.acceptOrReplay()`.
 */
export class CapsuleUnarchiveSubmissionService {
  constructor(
    private readonly repository: CapsuleUnarchiveRepository,
    private readonly executor: CapsuleUnarchiveExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
  ) {}

  public async submit(input: SubmitUnarchiveCapsuleInput): Promise<CapsuleUnarchiveReceipt> {
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.UNARCHIVE,
        capsuleId: input.capsuleId,
      } satisfies UnarchiveCapsuleRequestIdentity,
      'capsule unarchive request',
    )
    const acceptance = await this.repository.acceptOrReplay({
      ...input,
      requestHash,
    })
    if (!acceptance.newlyAccepted) {
      return acceptance.receipt
    }
    this.operationEvents.publishChanged(acceptance.operation)
    this.lifecycleEvents.publishChanged(acceptance.operation.ownerId, acceptance.capsule)
    const operationId = acceptance.receipt.operationId
    const executor = this.executor
    this.supervisor.schedule(operationId, () => executor.execute(operationId))
    return acceptance.receipt
  }
}
