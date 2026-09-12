import { and, asc, eq } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotResourceReferenceSchema,
  verifyCapsuleBlueprintPin,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import { readRootfs, sameRootfs } from '../operations/shared/rootfs'
import { volumeResourceKey } from '../resource/identity'
import { parseVolumeResourceMetadata } from '../resource/metadata'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleSnapshotRecord } from './types'

export type SnapshotReadTransaction<TDatabase extends PostgresJsDatabase> = Parameters<
  Parameters<TDatabase['transaction']>[0]
>[0]

interface SnapshotGraphRow {
  snapshot: CapsuleTables['capsuleSnapshots']['$inferSelect']
  branch: CapsuleTables['capsuleBranches']['$inferSelect'] | null
  creation: CapsuleTables['capsuleSnapshotCreateOperations']['$inferSelect'] | null
  operation: CapsuleTables['capsuleOperations']['$inferSelect'] | null
  reference: CapsuleTables['capsuleSnapshotResourceReferences']['$inferSelect'] | null
  resource: CapsuleTables['capsuleSnapshotCreateResources']['$inferSelect'] | null
  source: CapsuleTables['capsuleBranchResources']['$inferSelect'] | null
}

function conflict(snapshotId: string, message: string): never {
  throw new IncusError(message, 'CONFLICT', {
    snapshotId,
  })
}

/**
 * Reads complete committed restoration graphs.
 *
 * Left joins preserve incomplete references so contradictory history fails
 * validation instead of disappearing from a successful read.
 */
export class CapsuleSnapshotStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async list(ownerId: string, capsuleId: string): Promise<CapsuleSnapshotRecord[]> {
    return await this.persistence.db.transaction(
      async tx => {
        await this.assertOwner(tx, ownerId, capsuleId)
        const rows = await this.rows(tx, ownerId, capsuleId)
        const grouped = new Map<string, SnapshotGraphRow[]>()
        for (const row of rows) {
          const records = grouped.get(row.snapshot.id) ?? []
          records.push(row)
          grouped.set(row.snapshot.id, records)
        }
        return [...grouped.values()].map(records => this.validate(ownerId, records))
      },
      {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      },
    )
  }

  public async get(ownerId: string, capsuleId: string, snapshotId: string): Promise<CapsuleSnapshotRecord> {
    return await this.persistence.db.transaction(
      async tx => {
        return await this.read(tx, ownerId, capsuleId, snapshotId)
      },
      {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      },
    )
  }

  /**
   * Reads immutable restoration evidence inside an existing transaction.
   *
   * Mutation callers retain responsibility for their capsule and branch locks.
   * This method neither locks mutable runtime state nor authorizes mutation.
   */
  public async read(
    tx: SnapshotReadTransaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    snapshotId: string,
  ): Promise<CapsuleSnapshotRecord> {
    const rows = await this.rows(tx, ownerId, capsuleId, snapshotId)
    if (rows.length === 0) {
      throw new IncusError('Committed snapshot not found or access denied.', 'NOT_FOUND', {
        capsuleId,
        snapshotId,
      })
    }
    return this.validate(ownerId, rows)
  }

  private async assertOwner(tx: SnapshotReadTransaction<TDatabase>, ownerId: string, capsuleId: string): Promise<void> {
    const capsules = this.persistence.tables.capsules
    const [capsule] = await tx
      .select({
        id: capsules.id,
      })
      .from(capsules)
      .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
      .limit(1)
    if (!capsule) {
      throw new IncusError('Capsule not found or access denied.', 'NOT_FOUND', {
        capsuleId,
      })
    }
  }

  private async rows(
    tx: SnapshotReadTransaction<TDatabase>,
    ownerId: string,
    capsuleId: string,
    snapshotId?: string,
  ): Promise<SnapshotGraphRow[]> {
    const tables = this.persistence.tables
    return await tx
      .select({
        snapshot: tables.capsuleSnapshots,
        branch: tables.capsuleBranches,
        creation: tables.capsuleSnapshotCreateOperations,
        operation: tables.capsuleOperations,
        reference: tables.capsuleSnapshotResourceReferences,
        resource: tables.capsuleSnapshotCreateResources,
        source: tables.capsuleBranchResources,
      })
      .from(tables.capsuleSnapshots)
      .innerJoin(tables.capsules, eq(tables.capsules.id, tables.capsuleSnapshots.capsuleId))
      .leftJoin(tables.capsuleBranches, eq(tables.capsuleBranches.id, tables.capsuleSnapshots.sourceBranchId))
      .leftJoin(
        tables.capsuleSnapshotCreateOperations,
        eq(tables.capsuleSnapshotCreateOperations.snapshotId, tables.capsuleSnapshots.id),
      )
      .leftJoin(
        tables.capsuleOperations,
        eq(tables.capsuleOperations.id, tables.capsuleSnapshotCreateOperations.operationId),
      )
      .leftJoin(
        tables.capsuleSnapshotResourceReferences,
        eq(tables.capsuleSnapshotResourceReferences.snapshotId, tables.capsuleSnapshots.id),
      )
      .leftJoin(
        tables.capsuleSnapshotCreateResources,
        eq(tables.capsuleSnapshotCreateResources.id, tables.capsuleSnapshotResourceReferences.createResourceId),
      )
      .leftJoin(
        tables.capsuleBranchResources,
        eq(tables.capsuleBranchResources.id, tables.capsuleSnapshotResourceReferences.sourceBranchResourceId),
      )
      .where(
        and(
          eq(tables.capsules.ownerId, ownerId),
          eq(tables.capsuleSnapshots.capsuleId, capsuleId),
          snapshotId === undefined ? undefined : eq(tables.capsuleSnapshots.id, snapshotId),
        ),
      )
      .orderBy(
        asc(tables.capsuleSnapshots.createdAt),
        asc(tables.capsuleSnapshots.id),
        asc(tables.capsuleSnapshotResourceReferences.blueprintVolumeName),
      )
  }

  private validate(ownerId: string, rows: readonly SnapshotGraphRow[]): CapsuleSnapshotRecord {
    const first = rows[0]
    if (!first) {
      throw new IncusError('Committed snapshot graph is empty.', 'CONFLICT')
    }
    const { snapshot, branch, creation, operation } = first
    if (
      !branch ||
      !creation ||
      !operation ||
      branch.ownerId !== ownerId ||
      branch.capsuleId !== snapshot.capsuleId ||
      branch.id !== snapshot.sourceBranchId ||
      creation.snapshotId !== snapshot.id ||
      creation.sourceBranchId !== snapshot.sourceBranchId ||
      creation.sourceBranchName !== snapshot.sourceBranchName ||
      creation.sourceBranchResourceInventoryDigest !== snapshot.sourceBranchResourceInventoryDigest ||
      operation.id !== creation.operationId ||
      operation.ownerId !== ownerId ||
      operation.capsuleId !== snapshot.capsuleId ||
      operation.type !== CapsuleOperationType.SNAPSHOT_CREATE ||
      operation.status !== CapsuleOperationStatus.COMPLETED ||
      operation.executionStartedAt === null ||
      operation.completedAt === null ||
      operation.failedAt !== null ||
      operation.failureCode !== null ||
      operation.failureMessage !== null ||
      operation.failureDetails !== null
    ) {
      conflict(snapshot.id, 'Snapshot does not resolve a completed, owned Create Snapshot operation.')
    }
    const blueprint = verifyCapsuleBlueprintPin(snapshot.blueprintPin)
    const acceptedBlueprint = verifyCapsuleBlueprintPin(creation.blueprintPin)
    const rootfs = readRootfs(snapshot.rootfsImagePin, blueprint.blueprint.image_alias, {
      snapshotId: snapshot.id,
    })
    const acceptedRootfs = readRootfs(creation.rootfsImagePin, acceptedBlueprint.blueprint.image_alias, {
      snapshotId: snapshot.id,
      operationId: operation.id,
    })
    if (
      blueprint.blueprint.schema_version !== snapshot.blueprintSchemaVersion ||
      blueprint.name !== snapshot.blueprintName ||
      blueprint.digest !== snapshot.blueprintDigest ||
      acceptedBlueprint.blueprint.schema_version !== creation.blueprintSchemaVersion ||
      acceptedBlueprint.name !== creation.blueprintName ||
      acceptedBlueprint.digest !== creation.blueprintDigest ||
      acceptedBlueprint.name !== blueprint.name ||
      acceptedBlueprint.digest !== blueprint.digest ||
      !sameRootfs(rootfs, acceptedRootfs)
    ) {
      conflict(snapshot.id, 'Snapshot restoration pins disagree with their accepted operation input.')
    }
    const versionedVolumes = blueprint.blueprint.provisioning.volumes.filter(
      volume => volume.type !== 'bind' && volume.versioned,
    )
    if (
      (versionedVolumes.length > 0 && operation.providerMutationStartedAt === null) ||
      (versionedVolumes.length === 0 && operation.providerMutationStartedAt !== null)
    ) {
      conflict(snapshot.id, 'Snapshot provider intent does not agree with its versioned-volume coverage.')
    }
    const references = rows.flatMap(row => (row.reference === null ? [] : [row]))
    if (references.length !== versionedVolumes.length) {
      conflict(snapshot.id, 'Snapshot must retain exactly one reference for every versioned volume and no others.')
    }
    const seen = new Set<string>()
    const resources = references.map(row => {
      const { reference, resource, source } = row
      if (
        row.snapshot.id !== snapshot.id ||
        row.creation?.operationId !== creation.operationId ||
        row.operation?.id !== operation.id ||
        !reference ||
        !resource ||
        !source
      ) {
        conflict(snapshot.id, 'Snapshot contains incomplete or contradictory provider-reference provenance.')
      }
      const volume = versionedVolumes.find(candidate => candidate.name === reference.blueprintVolumeName)
      if (!volume || volume.type === 'bind' || !volume.versioned || seen.has(volume.name)) {
        conflict(snapshot.id, 'Snapshot contains a duplicate reference or a reference outside versioned storage.')
      }
      seen.add(volume.name)
      if (
        reference.snapshotId !== snapshot.id ||
        reference.createResourceId !== resource.id ||
        reference.sourceBranchResourceId !== source.id ||
        resource.operationId !== operation.id ||
        resource.sourceBranchResourceId !== source.id ||
        resource.blueprintVolumeName !== reference.blueprintVolumeName ||
        resource.provider !== reference.provider ||
        resource.kind !== reference.kind ||
        resource.project !== reference.project ||
        resource.pool !== reference.pool ||
        resource.sourceVolume !== reference.sourceVolume ||
        resource.snapshotName !== reference.snapshotName ||
        resource.status !== 'created' ||
        resource.failureCode !== null ||
        resource.failureMessage !== null ||
        resource.failureDetails !== null ||
        source.ownerId !== ownerId ||
        source.branchId !== snapshot.sourceBranchId ||
        source.provider !== 'incus' ||
        source.resourceType !== 'zfs_volume' ||
        source.cleanupPolicy !== 'delete_with_branch' ||
        source.blueprintVolumeName !== volume.name ||
        source.createdByOperationId === null
      ) {
        conflict(snapshot.id, 'Snapshot provider reference does not match its successful creation evidence.')
      }
      const metadata = parseVolumeResourceMetadata(source.metadata)
      if (
        metadata.namespace !== `user-${ownerId}` ||
        metadata.namespace !== reference.project ||
        metadata.pool !== volume.pool ||
        metadata.pool !== reference.pool ||
        metadata.volumeName !== reference.sourceVolume ||
        metadata.mountPath !== volume.mount_path ||
        metadata.versioned !== true ||
        source.resourceKey !== volumeResourceKey(metadata.namespace, metadata.pool, metadata.volumeName)
      ) {
        conflict(snapshot.id, 'Snapshot provider reference does not match its versioned-volume boundary.')
      }
      return CapsuleSnapshotResourceReferenceSchema.parse({
        provider: reference.provider,
        kind: reference.kind,
        blueprintVolumeName: reference.blueprintVolumeName,
        sourceBranchResourceId: reference.sourceBranchResourceId,
        createResourceId: reference.createResourceId,
        project: reference.project,
        pool: reference.pool,
        sourceVolume: reference.sourceVolume,
        snapshotName: reference.snapshotName,
      })
    })
    return {
      ...snapshot,
      blueprintPin: blueprint,
      rootfsImagePin: rootfs,
      resources,
    }
  }
}
