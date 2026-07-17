import { CapsuleOperationType, type CapsuleDestroyReceipt } from '@qiln/core/server'
import { createOperationRequestHash } from '../shared'
import type { OperationSupervisor } from '../../../../coordination'
import type { CapsuleBranchEventPublisher } from '../../events/branch'
import type { CapsuleLifecycleEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import type { DestroyCapsuleExecutor } from './executor'
import type { DestroyCapsuleOperationRepository } from './persistence/repository'
import type { SubmitDestroyCapsuleInput } from './types'

interface DestroyCapsuleRequestIdentity {
  operationType: typeof CapsuleOperationType.DESTROY
  capsuleId: string
}

/**
 * Accepts or replays destroy operations and schedules only newly accepted work.
 *
 * The service returns immediately after durable acceptance and never waits for
 * provider deletion or aggregate completion.
 *
 * Destroy has no mutable catalog dependency between replay lookup and durable
 * acceptance, so the repository owns the complete race-safe replay protocol.
 */
export class DestroyCapsuleSubmissionService {
  constructor(
    private readonly repository: DestroyCapsuleOperationRepository,
    private readonly executor: DestroyCapsuleExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
    private readonly branchEvents: CapsuleBranchEventPublisher,
  ) {}

  public async submit(input: SubmitDestroyCapsuleInput): Promise<CapsuleDestroyReceipt> {
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.DESTROY,
        capsuleId: input.capsuleId,
      } satisfies DestroyCapsuleRequestIdentity,
      'capsule destroy request',
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
    for (const branch of acceptance.branches) {
      this.branchEvents.publishStateChanged(acceptance.operation.ownerId, branch.capsuleId, branch.name, branch.status)
    }
    const operationId = acceptance.receipt.operationId
    const executor = this.executor
    this.supervisor.schedule(operationId, () => executor.execute(operationId))
    return acceptance.receipt
  }
}
