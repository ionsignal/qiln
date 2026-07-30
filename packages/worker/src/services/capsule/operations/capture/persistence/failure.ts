import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  verifyCapsuleSnapshotCapturePolicyPin,
  verifyCapsuleBlueprintPin,
  type CapsulePersistence,
  type CapsuleTables,
  type CapsuleOperationStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import {
  readRootfs,
  sameRootfs,
  toCapsuleLifecycleState,
  toCapsuleOperationTransition,
  type CapsuleOperationReader,
} from '../../shared'
import type { CapsuleBranchProvenance } from '../../../branch/provenance'
import type { CapsuleBranchResourceInventoryRow } from '../../../resource'
import type { CapturePlanner } from '../plan'
import type {
  CaptureAbandonedClassificationResult,
  CaptureCommittedBranch,
  CaptureResourceRecord,
  CaptureSourceBranch,
  CaptureTerminalResult,
} from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const NONTERMINAL_CAPTURE_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const

type PersistedCaptureOperation = CapsuleTables['capsuleOperations']['$inferSelect']
type PersistedCaptureCapsule = CapsuleTables['capsules']['$inferSelect']
type PersistedCaptureExtension = CapsuleTables['capsuleSnapshotCaptureOperations']['$inferSelect']

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
export class CaptureFailurePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly reader: CapsuleOperationReader<TDatabase, TTables>,
    private readonly planner: CapturePlanner,
    private readonly provenance: CapsuleBranchProvenance<TDatabase, TTables>,
  ) {}

  public async classify(
    operationId: string,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult | null> {
    return await this.persistence.db.transaction(async tx => {
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
          const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
          const rootfsImagePin = readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
            operationId,
            capsuleId: operation.capsuleId,
            sourceBranchId: sourceBranch.id,
          })
          const policy = verifyCapsuleSnapshotCapturePolicyPin(extension.capturePolicyPin)
          const source = await this.provenance.lock(tx, sourceBranch)
          if (
            blueprint.blueprint.schema_version !== extension.blueprintSchemaVersion ||
            blueprint.name !== extension.blueprintName ||
            blueprint.digest !== extension.blueprintDigest ||
            policy.schemaVersion !== extension.capturePolicySchemaVersion ||
            policy.digest !== extension.capturePolicyDigest ||
            policy.blueprintName !== blueprint.name ||
            sourceBranch.blueprintDigest !== blueprint.digest ||
            source.blueprint.name !== blueprint.name ||
            source.blueprint.digest !== blueprint.digest ||
            !sameRootfs(source.rootfsImagePin, rootfsImagePin) ||
            source.capturePolicy.schemaVersion !== policy.schemaVersion ||
            source.capturePolicy.digest !== policy.digest ||
            source.capturePolicy.blueprintName !== source.blueprint.name ||
            source.capturePolicy.blueprintDigest !== source.blueprint.digest ||
            sourceBranch.blueprintName !== blueprint.name ||
            sourceBranch.blueprintDigest !== blueprint.digest
          ) {
            reasons.push('capture_pin_reference_mismatch')
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
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedCaptureOperation,
    capsule: PersistedCaptureCapsule,
    branch: CaptureSourceBranch,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult> {
    const operations = this.persistence.tables.capsuleOperations
    const branches = this.persistence.tables.capsuleBranches
    const details = createFailureDetails(error, context)
    const now = new Date()
    const [failedOperation] = await tx
      .update(operations)
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
          eq(operations.id, operation.id),
          eq(operations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          inArray(operations.status, NONTERMINAL_CAPTURE_STATUSES),
          isNull(operations.providerMutationStartedAt),
        ),
      )
      .returning({
        id: operations.id,
      })
    const [offlineBranch] = await tx
      .update(branches)
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
          eq(branches.id, branch.id),
          eq(branches.ownerId, operation.ownerId),
          eq(branches.capsuleId, operation.capsuleId),
          eq(branches.status, 'capturing'),
        ),
      )
      .returning({
        id: branches.id,
        capsuleId: branches.capsuleId,
        name: branches.name,
        status: branches.status,
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
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operation: PersistedCaptureOperation,
    capsule: PersistedCaptureCapsule,
    extension: PersistedCaptureExtension | null,
    branches: readonly CaptureSourceBranch[],
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<CaptureTerminalResult> {
    const operations = this.persistence.tables.capsuleOperations
    const capsules = this.persistence.tables.capsules
    const branchTable = this.persistence.tables.capsuleBranches
    const details = createFailureDetails(error, context)
    const now = new Date()
    const [cleanupOperation] = await tx
      .update(operations)
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
          eq(operations.id, operation.id),
          eq(operations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          inArray(operations.status, NONTERMINAL_CAPTURE_STATUSES),
        ),
      )
      .returning({
        id: operations.id,
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
        .update(capsules)
        .set({
          lifecycleStatus: 'cleanup_required',
          updatedAt: now,
        })
        .where(
          and(
            eq(capsules.id, operation.capsuleId),
            eq(capsules.ownerId, operation.ownerId),
            ne(capsules.lifecycleStatus, 'destroyed'),
          ),
        )
        .returning({
          lifecycleStatus: capsules.lifecycleStatus,
          archivedAt: capsules.archivedAt,
          destroyedAt: capsules.destroyedAt,
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
        .update(branchTable)
        .set({
          status: 'cleanup_required',
          runtimeIp: null,
          updatedAt: now,
        })
        .where(
          and(
            inArray(branchTable.id, knownSourceBranchIds),
            eq(branchTable.ownerId, operation.ownerId),
            eq(branchTable.capsuleId, operation.capsuleId),
            ne(branchTable.status, 'destroyed'),
          ),
        )
        .returning({
          id: branchTable.id,
          capsuleId: branchTable.capsuleId,
          name: branchTable.name,
          status: branchTable.status,
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

  private async lockOperation(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedCaptureOperation> {
    const operations = this.persistence.tables.capsuleOperations
    const [operation] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.id, operationId), eq(operations.type, CapsuleOperationType.SNAPSHOT_CAPTURE)))
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
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
  ): Promise<PersistedCaptureCapsule> {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select()
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
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

  private async lockExtension(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<PersistedCaptureExtension | null> {
    const captureOperations = this.persistence.tables.capsuleSnapshotCaptureOperations
    const [extension] = await tx
      .select()
      .from(captureOperations)
      .where(eq(captureOperations.operationId, operationId))
      .for('update')
      .limit(1)
    return extension ?? null
  }

  private async lockBranches(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    capsuleId: string,
  ): Promise<CaptureSourceBranch[]> {
    const branches = this.persistence.tables.capsuleBranches
    return await tx
      .select({
        id: branches.id,
        ownerId: branches.ownerId,
        capsuleId: branches.capsuleId,
        name: branches.name,
        status: branches.status,
        isRootBranch: branches.isRootBranch,
        blueprintName: branches.blueprintName,
        blueprintDigest: branches.blueprintDigest,
        cpu: branches.cpu,
        memory: branches.memory,
        resourceInventoryDigest: branches.resourceInventoryDigest,
      })
      .from(branches)
      .where(eq(branches.capsuleId, capsuleId))
      .orderBy(asc(branches.id))
      .for('update')
  }

  private async lockInventory(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    branchId: string,
  ): Promise<CapsuleBranchResourceInventoryRow[]> {
    const resources = this.persistence.tables.capsuleBranchResources
    return await tx
      .select({
        id: resources.id,
        ownerId: resources.ownerId,
        branchId: resources.branchId,
        branchName: resources.branchName,
        provider: resources.provider,
        resourceType: resources.resourceType,
        resourceKey: resources.resourceKey,
        blueprintVolumeName: resources.blueprintVolumeName,
        status: resources.status,
        cleanupPolicy: resources.cleanupPolicy,
        metadata: resources.metadata,
        createdByOperationId: resources.createdByOperationId,
        lastOperationId: resources.lastOperationId,
      })
      .from(resources)
      .where(eq(resources.branchId, branchId))
      .orderBy(asc(resources.createdAt), asc(resources.id))
      .for('update')
  }

  private async lockResources(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    operationId: string,
  ): Promise<CaptureResourceRecord[]> {
    const resources = this.persistence.tables.capsuleSnapshotCaptureResources
    return await tx
      .select({
        id: resources.id,
        operationId: resources.operationId,
        sourceBranchResourceId: resources.sourceBranchResourceId,
        artifactRootId: resources.artifactRootId,
        blueprintVolumeName: resources.blueprintVolumeName,
        provider: resources.provider,
        kind: resources.kind,
        project: resources.project,
        pool: resources.pool,
        sourceVolume: resources.sourceVolume,
        snapshotName: resources.snapshotName,
        status: resources.status,
        snapshotIntentAt: resources.snapshotIntentAt,
        snapshotCreatedAt: resources.snapshotCreatedAt,
        cleanupIntentAt: resources.cleanupIntentAt,
        cleanupCompletedAt: resources.cleanupCompletedAt,
        failureCode: resources.failureCode,
        failureMessage: resources.failureMessage,
        failureDetails: resources.failureDetails,
        failureAt: resources.failureAt,
      })
      .from(resources)
      .where(eq(resources.operationId, operationId))
      .orderBy(asc(resources.artifactRootId), asc(resources.id))
      .for('update')
  }
}
