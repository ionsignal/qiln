import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  capsuleBranchesTable,
  capsuleBranchResourcesTable,
  capsuleOperationsTable,
  capsuleSnapshotCaptureOperationsTable,
  capsuleSnapshotCaptureResourcesTable,
  capsulesTable,
  verifyCapsuleSnapshotCapturePolicyPin,
  type CapsuleHostDbContract,
  type CapsuleOperationStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import { toCapsuleLifecycleState, toCapsuleOperationTransition, type CapsuleOperationReader } from '../../shared'
import type { CapsuleBranchResourceInventoryRow } from '../../../resource'
import type { CapturePlanner } from '../plan'
import type {
  CaptureAbandonedClassificationResult,
  CaptureCommittedBranch,
  CaptureResourceRecord,
  CaptureSourceBranch,
  CaptureTerminalResult,
} from '../types'

const NONTERMINAL_CAPTURE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type CaptureTransaction = Parameters<Parameters<CapsuleHostDbContract['transaction']>[0]>[0]
type PersistedCaptureOperation = typeof capsuleOperationsTable.$inferSelect
type PersistedCaptureCapsule = typeof capsulesTable.$inferSelect
type PersistedCaptureExtension = typeof capsuleSnapshotCaptureOperationsTable.$inferSelect

function isNonterminal(status: CapsuleOperationStatusValue): status is (typeof NONTERMINAL_CAPTURE_STATUSES)[number] {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

/**
 * Owns pre-provider Snapshot Capture failure and startup abandonment
 * classification.
 *
 * Ordinary failure is allowed only when PostgreSQL proves that provider intent
 * never committed and all accepted capture evidence remains intact. Any
 * contradiction fails closed to cleanup-required.
 */
export class CaptureFailurePersistence {
  constructor(
    private readonly db: CapsuleHostDbContract,
    private readonly reader: CapsuleOperationReader,
    private readonly planner: CapturePlanner,
  ) {}

  public async classify(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult | null> {
    return await this.db.transaction(async tx => {
      const operation = await this.lockOperation(tx, operationId)
      if (!isNonterminal(operation.status)) {
        return null
      }

      const capsule = await this.lockCapsule(tx, operation.ownerId, operation.capsuleId)
      const extension = await this.lockExtension(tx, operationId)
      const branches = await this.lockBranches(tx, operation.capsuleId)

      const sourceBranch =
        extension === null ? null : (branches.find(branch => branch.id === extension.sourceBranchId) ?? null)

      const reasons: string[] = []

      if (operation.providerMutationStartedAt !== null) {
        reasons.push('provider_intent_present')
      }
      if (extension === null) {
        reasons.push('capture_extension_missing')
      } else if (extension.snapshotId !== null) {
        reasons.push('unexpected_committed_snapshot_link')
      }
      if (capsule.lifecycleStatus !== 'active') {
        reasons.push('capsule_not_active')
      }
      if (capsule.archivedAt !== null) {
        reasons.push('capsule_archived')
      }
      if (sourceBranch === null) {
        reasons.push('source_branch_missing')
      } else {
        if (sourceBranch.ownerId !== operation.ownerId) {
          reasons.push('source_branch_owner_mismatch')
        }
        if (sourceBranch.capsuleId !== operation.capsuleId) {
          reasons.push('source_branch_capsule_mismatch')
        }
        if (sourceBranch.status !== 'capturing') {
          reasons.push('source_branch_not_capturing')
        }
        if (!sourceBranch.isRootBranch) {
          reasons.push('source_branch_not_root')
        }
        if (extension && sourceBranch.name !== extension.sourceBranchName) {
          reasons.push('source_branch_name_mismatch')
        }
        if (extension && sourceBranch.resourceInventoryDigest !== extension.sourceBranchResourceInventoryDigest) {
          reasons.push('source_branch_inventory_digest_mismatch')
        }
      }

      let evidenceError: unknown
      if (extension && sourceBranch) {
        try {
          const policy = verifyCapsuleSnapshotCapturePolicyPin(extension.capturePolicyPin)
          if (
            policy.schemaVersion !== extension.capturePolicySchemaVersion ||
            policy.digest !== extension.capturePolicyDigest
          ) {
            reasons.push('capture_policy_reference_mismatch')
          } else {
            const inventory = await this.lockInventory(tx, sourceBranch.id)
            const plan = this.planner.create(
              operationId,
              operation.ownerId,
              operation.capsuleId,
              sourceBranch,
              policy,
              inventory,
            )
            const resources = await this.lockResources(tx, operationId)
            this.planner.assertResources(operationId, plan, resources)
          }
        } catch (validationError: unknown) {
          evidenceError = validationError
          reasons.push('capture_evidence_invalid')
        }
      }

      if (reasons.length === 0 && sourceBranch && extension) {
        return await this.failInTransaction(tx, operation, capsule, sourceBranch, error, {
          ...context,
          classification: 'safe_pre_provider_capture_failure',
          providerIntentPresent: false,
          sourceBranchId: sourceBranch.id,
          capturePolicyDigest: extension.capturePolicyDigest,
        })
      }

      return await this.cleanupInTransaction(tx, operation, capsule, extension, branches, error, {
        ...context,
        classification: 'snapshot_capture_cleanup_required',
        previousOperationStatus: operation.status,
        providerIntentPresent: operation.providerMutationStartedAt !== null,
        providerMutationStartedAt: operation.providerMutationStartedAt?.toISOString() ?? null,
        reasons,
        evidenceError:
          evidenceError instanceof Error
            ? {
                name: evidenceError.name,
                message: evidenceError.message,
              }
            : undefined,
      })
    })
  }

  public async abandon(operationId: string): Promise<CaptureAbandonedClassificationResult> {
    const operation = await this.reader.loadById(operationId)
    if (!operation || operation.type !== CapsuleOperationType.SNAPSHOT_CAPTURE || !isNonterminal(operation.status)) {
      return null
    }

    const error = new IncusError(
      'Snapshot Capture operation was abandoned by a previous Worker process.',
      'API_ERROR',
      {
        operationId,
        capsuleId: operation.capsuleId,
        providerMutationStartedAt: operation.providerMutationStartedAt,
        policy: 'no_provider_mutation_after_worker_restart',
      },
    )

    return await this.classify(operationId, error, {
      operationId,
      capsuleId: operation.capsuleId,
      phase: 'startup_abandoned_operation_classification',
      action: 'classify_abandoned_snapshot_capture',
      policy: 'no_executor_replay_after_worker_restart',
    })
  }

  private async failInTransaction(
    tx: CaptureTransaction,
    operation: PersistedCaptureOperation,
    capsule: PersistedCaptureCapsule,
    branch: CaptureSourceBranch,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult> {
    const details = createFailureDetails(error, context)
    const now = new Date()

    const [failedOperation] = await tx
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.FAILED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Snapshot Capture failed before provider mutation.'),
        failureDetails:
          details === undefined ? undefined : toJsonObject(details, 'Snapshot Capture pre-provider failure details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operation.id),
          eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          inArray(capsuleOperationsTable.status, NONTERMINAL_CAPTURE_STATUSES),
          isNull(capsuleOperationsTable.providerMutationStartedAt),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })

    const [offlineBranch] = await tx
      .update(capsuleBranchesTable)
      .set({
        status: 'offline',
        runtimeIp: null,
        runtimeErrorCode: null,
        runtimeErrorMessage: null,
        runtimeErrorDetails: null,
        runtimeErrorAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleBranchesTable.id, branch.id),
          eq(capsuleBranchesTable.ownerId, operation.ownerId),
          eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
          eq(capsuleBranchesTable.status, 'capturing'),
        ),
      )
      .returning({
        id: capsuleBranchesTable.id,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
      })

    if (!failedOperation || !offlineBranch) {
      throw new IncusError(
        'Failed to atomically restore the source branch after pre-provider Snapshot Capture failure.',
        'CONFLICT',
        {
          operationId: operation.id,
          capsuleId: operation.capsuleId,
          sourceBranchId: branch.id,
        },
      )
    }

    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
        operationStatus: CapsuleOperationStatus.FAILED,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: capsule.lifecycleStatus,
        archivedAt: capsule.archivedAt,
        destroyedAt: capsule.destroyedAt,
      }),
      branches: [offlineBranch],
    }
  }

  private async cleanupInTransaction(
    tx: CaptureTransaction,
    operation: PersistedCaptureOperation,
    capsule: PersistedCaptureCapsule,
    extension: PersistedCaptureExtension | null,
    branches: readonly CaptureSourceBranch[],
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult> {
    const details = createFailureDetails(error, context)
    const now = new Date()

    const [cleanupOperation] = await tx
      .update(capsuleOperationsTable)
      .set({
        status: CapsuleOperationStatus.CLEANUP_REQUIRED,
        failedAt: now,
        failureCode: failureCodeFromUnknown(error),
        failureMessage: failureMessageFromUnknown(error, 'Snapshot Capture requires manual cleanup and inspection.'),
        failureDetails:
          details === undefined ? undefined : toJsonObject(details, 'Snapshot Capture cleanup-required details'),
        updatedAt: now,
      })
      .where(
        and(
          eq(capsuleOperationsTable.id, operation.id),
          eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          inArray(capsuleOperationsTable.status, NONTERMINAL_CAPTURE_STATUSES),
        ),
      )
      .returning({
        id: capsuleOperationsTable.id,
      })

    if (!cleanupOperation) {
      throw new IncusError('Failed to classify Snapshot Capture cleanup-required.', 'CONFLICT', {
        operationId: operation.id,
        capsuleId: operation.capsuleId,
      })
    }

    let committedCapsule = {
      lifecycleStatus: capsule.lifecycleStatus,
      archivedAt: capsule.archivedAt,
      destroyedAt: capsule.destroyedAt,
    }

    if (capsule.lifecycleStatus !== 'destroyed') {
      const [cleanupCapsule] = await tx
        .update(capsulesTable)
        .set({
          lifecycleStatus: 'cleanup_required',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsulesTable.id, operation.capsuleId),
            eq(capsulesTable.ownerId, operation.ownerId),
            ne(capsulesTable.lifecycleStatus, 'destroyed'),
          ),
        )
        .returning({
          lifecycleStatus: capsulesTable.lifecycleStatus,
          archivedAt: capsulesTable.archivedAt,
          destroyedAt: capsulesTable.destroyedAt,
        })

      if (!cleanupCapsule) {
        throw new IncusError(
          'Failed to mark the capsule cleanup-required after Snapshot Capture uncertainty.',
          'CONFLICT',
          {
            operationId: operation.id,
            capsuleId: operation.capsuleId,
          },
        )
      }

      committedCapsule = cleanupCapsule
    }

    const knownSourceBranchIds =
      extension === null
        ? branches.filter(branch => branch.status === 'capturing').map(branch => branch.id)
        : branches.filter(branch => branch.id === extension.sourceBranchId).map(branch => branch.id)

    let committedBranches: CaptureCommittedBranch[] = []

    if (knownSourceBranchIds.length > 0) {
      committedBranches = await tx
        .update(capsuleBranchesTable)
        .set({
          status: 'cleanup_required',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            inArray(capsuleBranchesTable.id, knownSourceBranchIds),
            eq(capsuleBranchesTable.ownerId, operation.ownerId),
            eq(capsuleBranchesTable.capsuleId, operation.capsuleId),
            ne(capsuleBranchesTable.status, 'destroyed'),
          ),
        )
        .returning({
          id: capsuleBranchesTable.id,
          capsuleId: capsuleBranchesTable.capsuleId,
          name: capsuleBranchesTable.name,
          status: capsuleBranchesTable.status,
        })
    }

    return {
      operation: toCapsuleOperationTransition({
        ownerId: operation.ownerId,
        operationId: operation.id,
        operationType: CapsuleOperationType.SNAPSHOT_CAPTURE,
        operationStatus: CapsuleOperationStatus.CLEANUP_REQUIRED,
        capsuleId: operation.capsuleId,
      }),
      capsule: toCapsuleLifecycleState({
        capsuleId: operation.capsuleId,
        lifecycleStatus: committedCapsule.lifecycleStatus,
        archivedAt: committedCapsule.archivedAt,
        destroyedAt: committedCapsule.destroyedAt,
      }),
      branches: committedBranches,
    }
  }

  private async lockOperation(tx: CaptureTransaction, operationId: string): Promise<PersistedCaptureOperation> {
    const [operation] = await tx
      .select()
      .from(capsuleOperationsTable)
      .where(
        and(
          eq(capsuleOperationsTable.id, operationId),
          eq(capsuleOperationsTable.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
        ),
      )
      .for('update')
      .limit(1)

    if (!operation) {
      throw new IncusError('Snapshot Capture operation was not found.', 'NOT_FOUND', {
        operationId,
      })
    }

    return operation
  }

  private async lockCapsule(
    tx: CaptureTransaction,
    ownerId: string,
    capsuleId: string,
  ): Promise<PersistedCaptureCapsule> {
    const [capsule] = await tx
      .select()
      .from(capsulesTable)
      .where(and(eq(capsulesTable.id, capsuleId), eq(capsulesTable.ownerId, ownerId)))
      .for('update')
      .limit(1)

    if (!capsule) {
      throw new IncusError('Snapshot Capture capsule was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
      })
    }

    return capsule
  }

  private async lockExtension(tx: CaptureTransaction, operationId: string): Promise<PersistedCaptureExtension | null> {
    const [extension] = await tx
      .select()
      .from(capsuleSnapshotCaptureOperationsTable)
      .where(eq(capsuleSnapshotCaptureOperationsTable.operationId, operationId))
      .for('update')
      .limit(1)

    return extension ?? null
  }

  private async lockBranches(tx: CaptureTransaction, capsuleId: string): Promise<CaptureSourceBranch[]> {
    return await tx
      .select({
        id: capsuleBranchesTable.id,
        ownerId: capsuleBranchesTable.ownerId,
        capsuleId: capsuleBranchesTable.capsuleId,
        name: capsuleBranchesTable.name,
        status: capsuleBranchesTable.status,
        isRootBranch: capsuleBranchesTable.isRootBranch,
        blueprintName: capsuleBranchesTable.blueprintName,
        blueprintDigest: capsuleBranchesTable.blueprintDigest,
        cpu: capsuleBranchesTable.cpu,
        memory: capsuleBranchesTable.memory,
        resourceInventoryDigest: capsuleBranchesTable.resourceInventoryDigest,
      })
      .from(capsuleBranchesTable)
      .where(eq(capsuleBranchesTable.capsuleId, capsuleId))
      .orderBy(asc(capsuleBranchesTable.id))
      .for('update')
  }

  private async lockInventory(tx: CaptureTransaction, branchId: string): Promise<CapsuleBranchResourceInventoryRow[]> {
    return await tx
      .select({
        id: capsuleBranchResourcesTable.id,
        ownerId: capsuleBranchResourcesTable.ownerId,
        branchId: capsuleBranchResourcesTable.branchId,
        branchName: capsuleBranchResourcesTable.branchName,
        provider: capsuleBranchResourcesTable.provider,
        resourceType: capsuleBranchResourcesTable.resourceType,
        resourceKey: capsuleBranchResourcesTable.resourceKey,
        blueprintVolumeName: capsuleBranchResourcesTable.blueprintVolumeName,
        status: capsuleBranchResourcesTable.status,
        cleanupPolicy: capsuleBranchResourcesTable.cleanupPolicy,
        metadata: capsuleBranchResourcesTable.metadata,
        createdByOperationId: capsuleBranchResourcesTable.createdByOperationId,
        lastOperationId: capsuleBranchResourcesTable.lastOperationId,
      })
      .from(capsuleBranchResourcesTable)
      .where(eq(capsuleBranchResourcesTable.branchId, branchId))
      .orderBy(asc(capsuleBranchResourcesTable.createdAt), asc(capsuleBranchResourcesTable.id))
      .for('update')
  }

  private async lockResources(tx: CaptureTransaction, operationId: string): Promise<CaptureResourceRecord[]> {
    return await tx
      .select({
        id: capsuleSnapshotCaptureResourcesTable.id,
        operationId: capsuleSnapshotCaptureResourcesTable.operationId,
        sourceBranchResourceId: capsuleSnapshotCaptureResourcesTable.sourceBranchResourceId,
        artifactRootId: capsuleSnapshotCaptureResourcesTable.artifactRootId,
        blueprintVolumeName: capsuleSnapshotCaptureResourcesTable.blueprintVolumeName,
        provider: capsuleSnapshotCaptureResourcesTable.provider,
        kind: capsuleSnapshotCaptureResourcesTable.kind,
        project: capsuleSnapshotCaptureResourcesTable.project,
        pool: capsuleSnapshotCaptureResourcesTable.pool,
        sourceVolume: capsuleSnapshotCaptureResourcesTable.sourceVolume,
        snapshotName: capsuleSnapshotCaptureResourcesTable.snapshotName,
        status: capsuleSnapshotCaptureResourcesTable.status,
        snapshotIntentAt: capsuleSnapshotCaptureResourcesTable.snapshotIntentAt,
        snapshotCreatedAt: capsuleSnapshotCaptureResourcesTable.snapshotCreatedAt,
        cleanupIntentAt: capsuleSnapshotCaptureResourcesTable.cleanupIntentAt,
        cleanupCompletedAt: capsuleSnapshotCaptureResourcesTable.cleanupCompletedAt,
        failureCode: capsuleSnapshotCaptureResourcesTable.failureCode,
        failureMessage: capsuleSnapshotCaptureResourcesTable.failureMessage,
        failureDetails: capsuleSnapshotCaptureResourcesTable.failureDetails,
        failureAt: capsuleSnapshotCaptureResourcesTable.failureAt,
      })
      .from(capsuleSnapshotCaptureResourcesTable)
      .where(eq(capsuleSnapshotCaptureResourcesTable.operationId, operationId))
      .orderBy(asc(capsuleSnapshotCaptureResourcesTable.artifactRootId), asc(capsuleSnapshotCaptureResourcesTable.id))
      .for('update')
  }
}
