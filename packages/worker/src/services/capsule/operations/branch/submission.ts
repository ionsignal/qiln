import type { OperationSupervisor } from '../../../../coordination'
import type { CapsuleBranchEventPublisher, CapsuleOperationEventPublisher } from '../../events'
import { createOperationRequestHash } from '../shared'
import type { BranchRepository } from './persistence/repository'
import type { BranchExecutor, BranchOperationType, BranchReceipt, SubmitBranchInput } from './types'

interface BranchRequestIdentity<TOperation extends BranchOperationType> {
  operationType: TOperation
  actor: SubmitBranchInput['actor']
  capsuleId: string
  branchId: string
}

/**
 * Shares request identity, acceptance publication, and supervised scheduling.
 *
 * The repository discriminator controls receipt inference. Execution remains
 * delegated to the separately composed start or stop executor.
 */
export class BranchSubmission<TOperation extends BranchOperationType> {
  constructor(
    private readonly repository: Pick<BranchRepository<TOperation>, 'type' | 'accept'>,
    private readonly executor: BranchExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly branchEvents: CapsuleBranchEventPublisher,
  ) {}

  public async submit(input: SubmitBranchInput): Promise<BranchReceipt<TOperation>> {
    const requestHash = createOperationRequestHash(
      {
        operationType: this.repository.type,
        actor: input.actor,
        capsuleId: input.capsuleId,
        branchId: input.branchId,
      } satisfies BranchRequestIdentity<TOperation>,
      `capsule ${this.repository.type} request`,
    )
    const acceptance = await this.repository.accept({
      ...input,
      requestHash,
    })
    if (!acceptance.newlyAccepted) {
      return acceptance.receipt
    }
    this.operationEvents.publishChanged(acceptance.operation)
    this.branchEvents.publishStateChanged(
      acceptance.operation.ownerId,
      acceptance.branch.capsuleId,
      acceptance.branch.name,
      acceptance.branch.status,
    )
    const operationId = acceptance.receipt.operationId
    const executor = this.executor

    // A rejected schedule leaves durable acceptance for startup abandonment.
    // Neither replay nor failed scheduling authorizes an untracked executor.
    this.supervisor.schedule(operationId, () => executor.execute(operationId))

    return acceptance.receipt
  }
}
