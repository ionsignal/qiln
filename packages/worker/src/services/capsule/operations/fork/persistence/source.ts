import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotLimitationsSchema,
  CapsuleSnapshotMode,
  verifyCapsuleBlueprintPin,
  verifyCapsuleSnapshotCapturePolicyPin,
  type CapsuleOperationTypeValue,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../../../errors'
import { readRootfs, sameRootfs } from '../../shared'
import type { ForkSource } from '../types'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type ForkOperation = CapsuleTables['capsuleOperations']['$inferSelect']
type ForkExtension = CapsuleTables['capsuleForkOperations']['$inferSelect']
type ForkBranch = CapsuleTables['capsuleBranches']['$inferSelect']

function compare(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const leftValues = [...left].sort(compare)
  const rightValues = [...right].sort(compare)
  return leftValues.every((value, index) => value === rightValues[index])
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value)
    }
    seen.add(value)
  }
  return [...duplicates].sort(compare)
}

/**
 * Validates immutable fork-operation evidence against the selected source
 * snapshot and provisional target branch.
 *
 * PostgreSQL proves row identity through foreign keys. This policy additionally
 * proves operation discriminators and immutable cross-table agreement.
 */
export function assertForkEvidence(
  operation: Pick<ForkOperation, 'id' | 'ownerId' | 'capsuleId' | 'type'>,
  extension: ForkExtension,
  source: ForkSource,
  branch: ForkBranch,
): void {
  if (operation.type !== CapsuleOperationType.FORK) {
    throw new IncusError('Fork extension is attached to a non-fork operation.', 'CONFLICT', {
      operationId: operation.id,
      operationType: operation.type,
    })
  }
  const blueprint = verifyCapsuleBlueprintPin(extension.blueprintPin)
  const rootfsImagePin = readRootfs(extension.rootfsImagePin, blueprint.blueprint.image_alias, {
    operationId: operation.id,
    sourceSnapshotId: source.snapshotId,
    targetBranchId: branch.id,
  })
  const policy = verifyCapsuleSnapshotCapturePolicyPin(extension.capturePolicyPin)
  const limitations = CapsuleSnapshotLimitationsSchema.parse(extension.sourceSnapshotLimitations)
  const contradictions: string[] = []
  if (extension.operationId !== operation.id) {
    contradictions.push('operation_id_mismatch')
  }
  if (extension.sourceSnapshotId !== source.snapshotId) {
    contradictions.push('source_snapshot_id_mismatch')
  }
  if (extension.targetBranchId !== branch.id) {
    contradictions.push('target_branch_id_mismatch')
  }
  if (extension.targetBranchName !== branch.name) {
    contradictions.push('target_branch_name_mismatch')
  }
  if (branch.ownerId !== operation.ownerId) {
    contradictions.push('target_branch_owner_mismatch')
  }
  if (branch.capsuleId !== operation.capsuleId) {
    contradictions.push('target_branch_capsule_mismatch')
  }
  if (branch.isRootBranch) {
    contradictions.push('target_branch_is_root')
  }
  if (branch.cpu !== extension.cpu) {
    contradictions.push('target_branch_cpu_mismatch')
  }
  if (branch.memory !== extension.memory) {
    contradictions.push('target_branch_memory_mismatch')
  }
  if (branch.blueprintName !== extension.blueprintName) {
    contradictions.push('target_branch_blueprint_name_mismatch')
  }
  if (branch.blueprintDigest !== extension.blueprintDigest) {
    contradictions.push('target_branch_blueprint_digest_mismatch')
  }
  if (branch.resourceInventoryDigest !== extension.targetBranchResourceInventoryDigest) {
    contradictions.push('target_branch_inventory_digest_mismatch')
  }
  if (blueprint.blueprint.schema_version !== extension.blueprintSchemaVersion) {
    contradictions.push('blueprint_schema_version_mismatch')
  }
  if (blueprint.name !== extension.blueprintName) {
    contradictions.push('blueprint_name_mismatch')
  }
  if (blueprint.digest !== extension.blueprintDigest) {
    contradictions.push('blueprint_digest_mismatch')
  }
  if (blueprint.name !== source.blueprint.name || blueprint.digest !== source.blueprint.digest) {
    contradictions.push('source_blueprint_mismatch')
  }
  if (!sameRootfs(rootfsImagePin, source.rootfsImagePin)) {
    contradictions.push('source_rootfs_image_mismatch')
  }
  if (policy.schemaVersion !== extension.capturePolicySchemaVersion) {
    contradictions.push('capture_policy_schema_version_mismatch')
  }
  if (policy.digest !== extension.capturePolicyDigest) {
    contradictions.push('capture_policy_digest_mismatch')
  }
  if (policy.blueprintName !== blueprint.name || policy.blueprintDigest !== blueprint.digest) {
    contradictions.push('capture_policy_blueprint_mismatch')
  }
  if (policy.digest !== source.capturePolicy.digest) {
    contradictions.push('source_capture_policy_mismatch')
  }
  if (extension.sourceSnapshotMode !== source.mode) {
    contradictions.push('source_snapshot_mode_mismatch')
  }
  if (!sameStrings(limitations, source.limitations)) {
    contradictions.push('source_snapshot_limitations_mismatch')
  }
  if (contradictions.length > 0) {
    throw new IncusError('Capsule fork immutable evidence is internally inconsistent.', 'CONFLICT', {
      operationId: operation.id,
      sourceSnapshotId: source.snapshotId,
      targetBranchId: branch.id,
      contradictions,
    })
  }
}

/**
 * Loads and locks the complete committed snapshot graph that may authorize a
 * fork.
 *
 * Managed volume clone authority comes only from committed snapshot resource
 * references whose exact provider identities agree with their successful
 * operation-scoped capture resources.
 */
export class ForkSourcePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async lock(
    tx: Parameters<Parameters<TDatabase['transaction']>[0]>[0],
    ownerId: string,
    capsuleId: string,
    snapshotId: string,
  ): Promise<ForkSource> {
    const tables = this.persistence.tables
    const [snapshot] = await tx
      .select()
      .from(tables.capsuleSnapshots)
      .where(and(eq(tables.capsuleSnapshots.id, snapshotId), eq(tables.capsuleSnapshots.capsuleId, capsuleId)))
      .for('update')
      .limit(1)
    if (!snapshot) {
      throw new IncusError('Fork source snapshot was not found.', 'NOT_FOUND', {
        ownerId,
        capsuleId,
        snapshotId,
      })
    }
    if (snapshot.mode !== CapsuleSnapshotMode.EXPERIMENTAL || snapshot.archivedAt !== null) {
      throw new IncusError('Fork source must be a committed, non-archived experimental snapshot.', 'CONFLICT', {
        ownerId,
        capsuleId,
        snapshotId,
        snapshotMode: snapshot.mode,
        archived: snapshot.archivedAt !== null,
      })
    }
    const limitations = CapsuleSnapshotLimitationsSchema.parse(snapshot.limitations)
    const blueprint = verifyCapsuleBlueprintPin(snapshot.blueprintPin)
    const rootfsImagePin = readRootfs(snapshot.rootfsImagePin, blueprint.blueprint.image_alias, {
      ownerId,
      capsuleId,
      snapshotId,
    })
    const policy = verifyCapsuleSnapshotCapturePolicyPin(snapshot.capturePolicyPin)
    const snapshotContradictions: string[] = []
    if (blueprint.blueprint.schema_version !== snapshot.blueprintSchemaVersion) {
      snapshotContradictions.push('blueprint_schema_version_mismatch')
    }
    if (blueprint.name !== snapshot.blueprintName) {
      snapshotContradictions.push('blueprint_name_mismatch')
    }
    if (blueprint.digest !== snapshot.blueprintDigest) {
      snapshotContradictions.push('blueprint_digest_mismatch')
    }
    if (policy.schemaVersion !== snapshot.capturePolicySchemaVersion) {
      snapshotContradictions.push('capture_policy_schema_version_mismatch')
    }
    if (policy.digest !== snapshot.capturePolicyDigest) {
      snapshotContradictions.push('capture_policy_digest_mismatch')
    }
    if (policy.blueprintName !== blueprint.name || policy.blueprintDigest !== blueprint.digest) {
      snapshotContradictions.push('capture_policy_blueprint_mismatch')
    }
    if (snapshotContradictions.length > 0) {
      throw new IncusError('Fork source snapshot contains contradictory immutable pins.', 'CONFLICT', {
        snapshotId,
        contradictions: snapshotContradictions,
      })
    }
    const captures = await tx
      .select()
      .from(tables.capsuleSnapshotCaptureOperations)
      .where(eq(tables.capsuleSnapshotCaptureOperations.snapshotId, snapshot.id))
      .orderBy(asc(tables.capsuleSnapshotCaptureOperations.operationId))
      .for('update')

    if (captures.length !== 1) {
      throw new IncusError('Fork source snapshot must have exactly one committed capture operation.', 'CONFLICT', {
        snapshotId,
        captureCount: captures.length,
      })
    }
    const capture = captures[0]!
    const [captureOperation] = await tx
      .select()
      .from(tables.capsuleOperations)
      .where(eq(tables.capsuleOperations.id, capture.operationId))
      .for('update')
      .limit(1)
    if (
      !captureOperation ||
      captureOperation.ownerId !== ownerId ||
      captureOperation.capsuleId !== capsuleId ||
      captureOperation.type !== CapsuleOperationType.SNAPSHOT_CAPTURE ||
      captureOperation.status !== CapsuleOperationStatus.COMPLETED ||
      captureOperation.completedAt === null
    ) {
      throw new IncusError('Fork source is not linked to a completed owned Snapshot Capture operation.', 'CONFLICT', {
        ownerId,
        capsuleId,
        snapshotId,
        captureOperationId: capture.operationId,
        captureOperationType: captureOperation?.type ?? null,
        captureOperationStatus: captureOperation?.status ?? null,
      })
    }
    const captureBlueprint = verifyCapsuleBlueprintPin(capture.blueprintPin)
    const captureRootfsImagePin = readRootfs(capture.rootfsImagePin, captureBlueprint.blueprint.image_alias, {
      ownerId,
      capsuleId,
      snapshotId,
      captureOperationId: capture.operationId,
    })
    const capturePolicy = verifyCapsuleSnapshotCapturePolicyPin(capture.capturePolicyPin)
    const captureContradictions: string[] = []
    if (capture.sourceBranchId !== snapshot.sourceBranchId) {
      captureContradictions.push('source_branch_id_mismatch')
    }
    if (capture.sourceBranchName !== snapshot.sourceBranchName) {
      captureContradictions.push('source_branch_name_mismatch')
    }
    if (capture.sourceBranchResourceInventoryDigest !== snapshot.sourceBranchResourceInventoryDigest) {
      captureContradictions.push('source_branch_inventory_digest_mismatch')
    }
    if (capture.blueprintSchemaVersion !== snapshot.blueprintSchemaVersion) {
      captureContradictions.push('blueprint_schema_version_mismatch')
    }
    if (capture.blueprintName !== snapshot.blueprintName) {
      captureContradictions.push('blueprint_name_mismatch')
    }
    if (capture.blueprintDigest !== snapshot.blueprintDigest) {
      captureContradictions.push('blueprint_digest_mismatch')
    }
    if (captureBlueprint.name !== blueprint.name || captureBlueprint.digest !== blueprint.digest) {
      captureContradictions.push('blueprint_pin_mismatch')
    }
    if (!sameRootfs(captureRootfsImagePin, rootfsImagePin)) {
      captureContradictions.push('rootfs_image_pin_mismatch')
    }
    if (capture.capturePolicySchemaVersion !== snapshot.capturePolicySchemaVersion) {
      captureContradictions.push('capture_policy_schema_version_mismatch')
    }
    if (capture.capturePolicyDigest !== snapshot.capturePolicyDigest) {
      captureContradictions.push('capture_policy_digest_mismatch')
    }
    if (capturePolicy.digest !== policy.digest) {
      captureContradictions.push('capture_policy_pin_mismatch')
    }
    if (capture.requestedMode !== snapshot.mode) {
      captureContradictions.push('snapshot_mode_mismatch')
    }
    if (captureContradictions.length > 0) {
      throw new IncusError('Fork source Snapshot Capture evidence disagrees with committed history.', 'CONFLICT', {
        snapshotId,
        captureOperationId: capture.operationId,
        contradictions: captureContradictions,
      })
    }
    const manifests = await tx
      .select()
      .from(tables.capsuleArtifactManifests)
      .where(eq(tables.capsuleArtifactManifests.snapshotId, snapshot.id))
      .orderBy(asc(tables.capsuleArtifactManifests.id))
      .for('update')
    if (manifests.length !== 1) {
      throw new IncusError('Fork source snapshot must have exactly one committed artifact manifest.', 'CONFLICT', {
        snapshotId,
        manifestCount: manifests.length,
      })
    }
    const manifest = manifests[0]!
    const roots = await tx
      .select()
      .from(tables.capsuleArtifactManifestRoots)
      .where(eq(tables.capsuleArtifactManifestRoots.manifestId, manifest.id))
      .orderBy(asc(tables.capsuleArtifactManifestRoots.rootId), asc(tables.capsuleArtifactManifestRoots.id))
      .for('update')
    const policyRootIds = policy.artifactRoots.map(root => root.id)
    const persistedRootIds = roots.map(root => root.rootId)
    const duplicateRootIds = duplicateValues(persistedRootIds)
    if (
      duplicateRootIds.length > 0 ||
      roots.length !== policy.artifactRoots.length ||
      policy.artifactRoots.some(policyRoot => {
        const root = roots.find(candidate => candidate.rootId === policyRoot.id)
        return !root || root.logicalPath !== policyRoot.logicalPath
      })
    ) {
      throw new IncusError(
        'Fork source manifest roots do not exactly match the historical capture policy.',
        'CONFLICT',
        {
          snapshotId,
          manifestId: manifest.id,
          policyRootIds: [...policyRootIds].sort(compare),
          persistedRootIds: [...persistedRootIds].sort(compare),
          duplicateRootIds,
        },
      )
    }
    const references = await tx
      .select({
        id: tables.capsuleSnapshotResourceReferences.id,
        snapshotId: tables.capsuleSnapshotResourceReferences.snapshotId,
        manifestRootId: tables.capsuleSnapshotResourceReferences.manifestRootId,
        artifactRootId: tables.capsuleArtifactManifestRoots.rootId,
        blueprintVolumeName: tables.capsuleSnapshotResourceReferences.blueprintVolumeName,
        sourceBranchResourceId: tables.capsuleSnapshotResourceReferences.sourceBranchResourceId,
        captureResourceId: tables.capsuleSnapshotResourceReferences.captureResourceId,
        provider: tables.capsuleSnapshotResourceReferences.provider,
        kind: tables.capsuleSnapshotResourceReferences.kind,
        project: tables.capsuleSnapshotResourceReferences.project,
        pool: tables.capsuleSnapshotResourceReferences.pool,
        sourceVolume: tables.capsuleSnapshotResourceReferences.sourceVolume,
        snapshotName: tables.capsuleSnapshotResourceReferences.snapshotName,
        captureOperationId: tables.capsuleSnapshotCaptureResources.operationId,
        captureSourceBranchResourceId: tables.capsuleSnapshotCaptureResources.sourceBranchResourceId,
        captureArtifactRootId: tables.capsuleSnapshotCaptureResources.artifactRootId,
        captureBlueprintVolumeName: tables.capsuleSnapshotCaptureResources.blueprintVolumeName,
        captureProvider: tables.capsuleSnapshotCaptureResources.provider,
        captureKind: tables.capsuleSnapshotCaptureResources.kind,
        captureProject: tables.capsuleSnapshotCaptureResources.project,
        capturePool: tables.capsuleSnapshotCaptureResources.pool,
        captureSourceVolume: tables.capsuleSnapshotCaptureResources.sourceVolume,
        captureSnapshotName: tables.capsuleSnapshotCaptureResources.snapshotName,
        captureStatus: tables.capsuleSnapshotCaptureResources.status,
        snapshotIntentAt: tables.capsuleSnapshotCaptureResources.snapshotIntentAt,
        snapshotCreatedAt: tables.capsuleSnapshotCaptureResources.snapshotCreatedAt,
        cleanupIntentAt: tables.capsuleSnapshotCaptureResources.cleanupIntentAt,
        cleanupCompletedAt: tables.capsuleSnapshotCaptureResources.cleanupCompletedAt,
        failureAt: tables.capsuleSnapshotCaptureResources.failureAt,
      })
      .from(tables.capsuleSnapshotResourceReferences)
      .innerJoin(
        tables.capsuleArtifactManifestRoots,
        and(
          eq(tables.capsuleArtifactManifestRoots.id, tables.capsuleSnapshotResourceReferences.manifestRootId),
          eq(tables.capsuleArtifactManifestRoots.manifestId, manifest.id),
        ),
      )
      .innerJoin(
        tables.capsuleSnapshotCaptureResources,
        eq(tables.capsuleSnapshotCaptureResources.id, tables.capsuleSnapshotResourceReferences.captureResourceId),
      )
      .where(eq(tables.capsuleSnapshotResourceReferences.snapshotId, snapshot.id))
      .orderBy(asc(tables.capsuleArtifactManifestRoots.rootId), asc(tables.capsuleSnapshotResourceReferences.id))
      .for('update')
    if (references.length !== policy.artifactRoots.length) {
      throw new IncusError('Fork source snapshot does not retain every managed storage reference.', 'CONFLICT', {
        snapshotId,
        expectedReferenceCount: policy.artifactRoots.length,
        actualReferenceCount: references.length,
      })
    }
    const duplicateReferenceRoots = duplicateValues(references.map(reference => reference.artifactRootId))
    const duplicateReferenceVolumes = duplicateValues(references.map(reference => reference.blueprintVolumeName))
    if (duplicateReferenceRoots.length > 0 || duplicateReferenceVolumes.length > 0) {
      throw new IncusError('Fork source snapshot contains duplicate managed storage references.', 'CONFLICT', {
        snapshotId,
        duplicateReferenceRoots,
        duplicateReferenceVolumes,
      })
    }
    const resources = references.map(reference => {
      const policyRoot = policy.artifactRoots.find(root => root.id === reference.artifactRootId)
      const contradictions: string[] = []
      if (!policyRoot) {
        contradictions.push('unknown_artifact_root')
      } else if (policyRoot.blueprintVolumeName !== reference.blueprintVolumeName) {
        contradictions.push('blueprint_volume_name_mismatch')
      }
      if (reference.snapshotId !== snapshot.id) {
        contradictions.push('snapshot_id_mismatch')
      }
      if (reference.captureOperationId !== capture.operationId) {
        contradictions.push('capture_operation_id_mismatch')
      }
      if (reference.sourceBranchResourceId !== reference.captureSourceBranchResourceId) {
        contradictions.push('source_branch_resource_id_mismatch')
      }
      if (reference.artifactRootId !== reference.captureArtifactRootId) {
        contradictions.push('artifact_root_id_mismatch')
      }
      if (reference.blueprintVolumeName !== reference.captureBlueprintVolumeName) {
        contradictions.push('capture_blueprint_volume_name_mismatch')
      }
      if (reference.provider !== reference.captureProvider) {
        contradictions.push('provider_mismatch')
      }
      if (reference.kind !== reference.captureKind) {
        contradictions.push('kind_mismatch')
      }
      if (reference.project !== reference.captureProject) {
        contradictions.push('project_mismatch')
      }
      if (reference.pool !== reference.capturePool) {
        contradictions.push('pool_mismatch')
      }
      if (reference.sourceVolume !== reference.captureSourceVolume) {
        contradictions.push('source_volume_mismatch')
      }
      if (reference.snapshotName !== reference.captureSnapshotName) {
        contradictions.push('snapshot_name_mismatch')
      }
      if (
        reference.captureStatus !== 'created' ||
        reference.snapshotIntentAt === null ||
        reference.snapshotCreatedAt === null ||
        reference.cleanupIntentAt !== null ||
        reference.cleanupCompletedAt !== null ||
        reference.failureAt !== null
      ) {
        contradictions.push('capture_resource_not_commit_ready')
      }
      if (contradictions.length > 0) {
        throw new IncusError('Fork source provider reference lacks exact successful capture provenance.', 'CONFLICT', {
          snapshotId,
          referenceId: reference.id,
          captureResourceId: reference.captureResourceId,
          contradictions,
        })
      }
      return {
        id: reference.id,
        artifactRootId: reference.artifactRootId,
        blueprintVolumeName: reference.blueprintVolumeName,
        sourceBranchResourceId: reference.sourceBranchResourceId,
        captureResourceId: reference.captureResourceId,
        provider: reference.provider,
        kind: reference.kind,
        project: reference.project,
        pool: reference.pool,
        sourceVolume: reference.sourceVolume,
        snapshotName: reference.snapshotName,
      }
    })
    return {
      snapshotId: snapshot.id,
      capsuleId: snapshot.capsuleId,
      blueprint,
      rootfsImagePin,
      capturePolicy: policy,
      mode: snapshot.mode,
      limitations,
      resources,
    }
  }
}

export function assertForkOperationType(
  operationType: CapsuleOperationTypeValue,
  operationId: string,
): asserts operationType is typeof CapsuleOperationType.FORK {
  if (operationType !== CapsuleOperationType.FORK) {
    throw new IncusError('Operation is not a capsule fork operation.', 'CONFLICT', {
      operationId,
      operationType,
    })
  }
}
