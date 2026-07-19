import { CapsuleOperationType, type CapsuleArchiveReceipt } from '@qiln/core/server'
import { createOperationRequestHash } from '../../shared'
import type { OperationSupervisor } from '../../../../../coordination'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../../events'
import type { CapsuleArchiveExecutor } from './executor'
import type { CapsuleArchiveRepository } from './repository'
import type { SubmitArchiveCapsuleInput } from './types'

interface ArchiveCapsuleRequestIdentity {
  operationType: typeof CapsuleOperationType.ARCHIVE
  actor: SubmitArchiveCapsuleInput['actor']
  capsuleId: string
}

/**
 * Accepts or replays archive operations and schedules only newly accepted work.
 *
 * Archive has no mutable catalog dependency between replay detection and
 * durable acceptance. Its complete race-safe replay protocol therefore belongs
 * to `CapsuleArchiveRepository.acceptOrReplay()` rather than being duplicated
 * by this submission service.
 */
export class CapsuleArchiveSubmissionService {
  constructor(
    private readonly repository: CapsuleArchiveRepository,
    private readonly executor: CapsuleArchiveExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
  ) {}

  public async submit(input: SubmitArchiveCapsuleInput): Promise<CapsuleArchiveReceipt> {
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.ARCHIVE,
        actor: input.actor,
        capsuleId: input.capsuleId,
      } satisfies ArchiveCapsuleRequestIdentity,
      'capsule archive request',
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
