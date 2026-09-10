import { CapsuleOperationType, type CapsuleForkReceipt } from '@qiln/core/server'
import { createOperationRequestHash } from '../shared'
import type { OperationSupervisor } from '../../../../coordination'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { ForkExecutor } from './executor'
import type { ForkRepository } from './persistence'
import type { SubmitForkInput } from './types'

interface ForkRequestIdentity {
  operationType: typeof CapsuleOperationType.FORK
  actor: SubmitForkInput['actor']
  capsuleId: string
  sourceSnapshotId: string
  branchName: string
  cpu: string
  memory: string
}

/**
 * Accepts or replays branches forked from committed snapshots.
 *
 * Only newly accepted operations are scheduled. Replay never authorizes a
 * replacement executor or additional provider mutation.
 */
export class ForkSubmission {
  constructor(
    private readonly repository: ForkRepository,
    private readonly executor: ForkExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
    private readonly branchEvents: CapsuleBranchEventPublisher,
  ) {}

  public async submit(input: SubmitForkInput): Promise<CapsuleForkReceipt> {
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.FORK,
        actor: input.actor,
        capsuleId: input.capsuleId,
        sourceSnapshotId: input.sourceSnapshotId,
        branchName: input.branchName,
        cpu: input.cpu,
        memory: input.memory,
      } satisfies ForkRequestIdentity,
      'capsule fork request',
    )
    const acceptance = await this.repository.accept({
      ...input,
      requestHash,
    })
    if (!acceptance.newlyAccepted) {
      return acceptance.receipt
    }
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
    this.supervisor.schedule(operationId, () => executor.execute(operationId))
    return acceptance.receipt
  }
}
