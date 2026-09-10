import {
  CapsuleActorReferenceSchema,
  CapsuleOperationIdempotencyKeySchema,
  CapsuleOperationType,
  type CapsuleSnapshotCreateReceipt,
} from '@qiln/core/server'
import { z } from 'zod'
import { createOperationRequestHash } from '../shared/requestHash'
import type { OperationSupervisor } from '../../../../coordination'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../../events'
import type { SnapshotExecutor } from './executor'
import type { SnapshotRepository } from './persistence'
import type { SnapshotSubmissionInput } from './types'

const SubmissionSchema = z
  .object({
    ownerId: z.uuid(),
    actor: CapsuleActorReferenceSchema,
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

/**
 * Returns durable acceptance or replay without waiting for provider execution.
 *
 * Replays never schedule a replacement executor.
 */
export class SnapshotSubmission {
  constructor(
    private readonly repository: SnapshotRepository,
    private readonly executor: SnapshotExecutor,
    private readonly supervisor: OperationSupervisor,
    private readonly operationEvents: CapsuleOperationEventPublisher,
    private readonly lifecycleEvents: CapsuleLifecycleEventPublisher,
    private readonly branchEvents: CapsuleBranchEventPublisher,
  ) {}

  public async submit(input: SnapshotSubmissionInput): Promise<CapsuleSnapshotCreateReceipt> {
    const request = SubmissionSchema.parse(input)
    const requestHash = createOperationRequestHash(
      {
        operationType: CapsuleOperationType.SNAPSHOT_CREATE,
        ownerId: request.ownerId,
        actor: request.actor,
        capsuleId: request.capsuleId,
        sourceBranchId: request.sourceBranchId,
      },
      'Create Snapshot request',
    )
    const acceptance = await this.repository.accept({
      ...request,
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
    this.supervisor.schedule(operationId, () => this.executor.execute(operationId))
    return acceptance.receipt
  }
}
