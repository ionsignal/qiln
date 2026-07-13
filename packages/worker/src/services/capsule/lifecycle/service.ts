import {
  CapsuleLifecycleOperationRequestHashSchema,
  CapsuleLifecycleOperationType,
  digestCanonicalJsonValue,
  type CapsuleLifecycleOperationRequestHash,
} from '@qiln/core/server'
import { CapsuleAbandonedLifecycleOperationError, createLifecycleOperationFailureContext } from '../lifecycleLedger/errors'
import { CapsuleDestroyCoordinator } from './destroy/coordinator'
import type { CapsuleBranchEventPublisher } from '../branch/events'
import type { CapsuleBranchStore, CapsuleLifecycleOperationStore } from '../stores'
import type { CapsuleLifecycleEventPublisher } from './events'
import type {
  CapsuleArchiveServiceInput,
  CapsuleArchiveServiceOutput,
  CapsuleDestroyServiceInput,
  CapsuleDestroyServiceOutput,
  CapsuleLogicalLifecycleInput,
  CapsuleUnarchiveServiceInput,
  CapsuleUnarchiveServiceOutput,
} from './types'

interface CapsuleLogicalLifecycleRequestHashInput {
  operationType: 'archive' | 'unarchive'
  capsuleId: string
}

export interface CapsuleLifecycleServiceDependencies {
  operations: CapsuleLifecycleOperationStore
  branches: CapsuleBranchStore
  destroy: CapsuleDestroyCoordinator
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
}

function createLogicalLifecycleRequestHash(
  operationType: CapsuleLogicalLifecycleRequestHashInput['operationType'],
  capsuleId: string,
): CapsuleLifecycleOperationRequestHash {
  const digest = digestCanonicalJsonValue(
    {
      operationType,
      capsuleId,
    } satisfies CapsuleLogicalLifecycleRequestHashInput,
    {
      context: `capsule ${operationType} request`,
    },
  )

  return CapsuleLifecycleOperationRequestHashSchema.parse(digest)
}

/**
 * Owns capsule-level logical archive state and terminal destroy orchestration.
 *
 * Archive and unarchive are one-transaction logical changes. Destroy delegates to its dedicated
 * provider-aware coordinator.
 */
export class CapsuleLifecycleService {
  constructor(private readonly dependencies: CapsuleLifecycleServiceDependencies) {}

  public async archive(input: CapsuleArchiveServiceInput): Promise<CapsuleArchiveServiceOutput> {
    const output = await this.dependencies.operations.archiveCapsule({
      ...this.lifecycleIdentity(input),
      requestHash: createLogicalLifecycleRequestHash(CapsuleLifecycleOperationType.ARCHIVE, input.capsuleId),
    })
    this.dependencies.lifecycleEvents.publishChanged(input.ownerId, {
      capsuleId: output.capsuleId,
      lifecycleStatus: output.lifecycleStatus,
      archivedAt: output.archivedAt,
      destroyedAt: output.destroyedAt,
    })
    return output
  }

  public async unarchive(input: CapsuleUnarchiveServiceInput): Promise<CapsuleUnarchiveServiceOutput> {
    const output = await this.dependencies.operations.unarchiveCapsule({
      ...this.lifecycleIdentity(input),
      requestHash: createLogicalLifecycleRequestHash(CapsuleLifecycleOperationType.UNARCHIVE, input.capsuleId),
    })
    this.dependencies.lifecycleEvents.publishChanged(input.ownerId, {
      capsuleId: output.capsuleId,
      lifecycleStatus: output.lifecycleStatus,
      archivedAt: output.archivedAt,
      destroyedAt: output.destroyedAt,
    })
    return output
  }

  public async destroy(input: CapsuleDestroyServiceInput): Promise<CapsuleDestroyServiceOutput> {
    return await this.dependencies.destroy.execute(input)
  }

  /**
   * Marks destroy operations abandoned by a previous Worker process as
   * cleanup-required. No provider state is read and no destroy step is resumed.
   */
  public async markAbandonedDestroyOperationsCleanupRequired(): Promise<void> {
    const candidates = await this.dependencies.operations.listAbandonedDestroyOperationCandidates()
    if (candidates.length === 0) {
      return
    }
    console.warn(
      `[CapsuleLifecycleService] Found ${candidates.length} abandoned capsule destroy operation(s). Marking cleanup_required; automatic recovery is disabled.`,
    )
    for (const candidate of candidates) {
      const branches = await this.dependencies.branches.listBranchesForCapsule(candidate.ownerId, candidate.capsuleId)
      const error = new CapsuleAbandonedLifecycleOperationError('Capsule destroy lifecycle operation was abandoned before completion.', {
        operationId: candidate.id,
        capsuleId: candidate.capsuleId,
        ownerId: candidate.ownerId,
        previousOperationStatus: candidate.status,
        branchCount: branches.length,
        branchStatuses: branches.map(branch => ({
          branchId: branch.id,
          branchName: branch.name,
          status: branch.status,
        })),
        policy: 'inline_fail_closed_lifecycle_ledger',
      })
      const marked = await this.dependencies.operations.markAbandonedLifecycleOperationCleanupRequired(
        candidate.ownerId,
        candidate.capsuleId,
        candidate.id,
        error,
        createLifecycleOperationFailureContext({
          operationId: candidate.id,
          capsuleId: candidate.capsuleId,
          phase: 'startup_fail_closed_sweep',
          action: 'mark_abandoned_capsule_destroy_cleanup_required',
          resourceOwnershipUncertain: true,
        }),
      )
      if (!marked) {
        continue
      }
      for (const branch of branches) {
        if (branch.status === 'destroyed') {
          continue
        }
        this.dependencies.branchEvents.publishStateChanged(candidate.ownerId, candidate.capsuleId, branch.name, 'cleanup_required')
      }
    }
  }

  private lifecycleIdentity(input: CapsuleLogicalLifecycleInput) {
    return {
      ownerId: input.ownerId,
      capsuleId: input.capsuleId,
      idempotencyKey: input.idempotencyKey,
    }
  }
}
