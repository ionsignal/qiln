import { and, asc, eq, isNull } from 'drizzle-orm'
import {
  AgentSnapshotArtifactEntrySchema,
  AgentSnapshotArtifactRootSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotResourceReferenceSchema,
  digestCapsuleArtifactManifest,
  normalizeCapsuleArtifactManifest,
  toCanonicalCapsuleArtifactTimestamp,
  type AgentSnapshotArtifactEntry,
  type AgentSnapshotArtifactRoot,
  type CapsuleArtifactManifest,
  type CapsuleArtifactManifestDigest,
  type CapsuleSnapshotAgentArtifactContentPolicyValue,
  type CapsuleSnapshotResourceReference,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

const MAX_COMMITTED_MANIFEST_ROOTS = 1_000
const MAX_COMMITTED_MANIFEST_ENTRIES = 25_000

export interface CommittedSnapshotArtifacts {
  snapshotId: string
  agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicyValue
  manifestSchemaVersion: CapsuleArtifactManifest['schemaVersion']
  manifestDigest: CapsuleArtifactManifestDigest
  manifest: CapsuleArtifactManifest
  rootsById: ReadonlyMap<string, string>
}

export class CapsuleSnapshotArtifactStore<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async load(ownerId: string, capsuleId: string, snapshotId: string): Promise<CommittedSnapshotArtifacts> {
    const header = await this.header(ownerId, capsuleId, snapshotId)
    const roots = await this.roots(header.manifestId)
    const entries = await this.entries(header.manifestId)
    let manifest: CapsuleArtifactManifest
    let manifestDigest: CapsuleArtifactManifestDigest
    try {
      const rootsByDatabaseId = new Map(roots.map(root => [root.id, root.rootId] as const))
      const manifestRoots = roots.map(root =>
        AgentSnapshotArtifactRootSchema.parse({
          id: root.rootId,
          logicalPath: root.logicalPath,
        }),
      )
      const manifestEntries = entries.map(entry => {
        const rootId = rootsByDatabaseId.get(entry.manifestRootId)
        if (!rootId) {
          throw new IncusError('Committed artifact manifest entry references an unknown root.', 'CONFLICT', {
            snapshotId,
          })
        }
        return AgentSnapshotArtifactEntrySchema.parse({
          rootId,
          logicalPath: entry.logicalPath,
          type: entry.type,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          modifiedAt: toCanonicalCapsuleArtifactTimestamp(entry.modifiedAt),
          ...(entry.type === 'file'
            ? {
                size: entry.size,
                contentDigest: entry.contentDigest,
              }
            : {}),
        })
      })
      manifest = normalizeCapsuleArtifactManifest({
        schemaVersion: header.manifestSchemaVersion,
        roots: manifestRoots,
        entries: manifestEntries,
      })
      manifestDigest = digestCapsuleArtifactManifest(manifest)
      if (manifestDigest !== header.manifestDigest) {
        throw new IncusError('Committed artifact manifest evidence is inconsistent.', 'CONFLICT', {
          snapshotId,
        })
      }
    } catch (error: unknown) {
      if (error instanceof IncusError) {
        throw error
      }
      throw new IncusError('Committed artifact manifest evidence is invalid.', 'CONFLICT', {
        snapshotId,
        reason: error instanceof Error ? error.message : 'Unknown manifest validation failure.',
      })
    }
    return {
      snapshotId,
      agentArtifactContentPolicy: header.agentArtifactContentPolicy,
      manifestSchemaVersion: manifest.schemaVersion,
      manifestDigest,
      manifest,
      rootsById: new Map(roots.map(root => [root.rootId, root.id] as const)),
    }
  }

  public async reference(
    artifacts: CommittedSnapshotArtifacts,
    rootId: string,
  ): Promise<CapsuleSnapshotResourceReference> {
    const manifestRootId = artifacts.rootsById.get(rootId)
    if (!manifestRootId) {
      throw new IncusError('Committed artifact root was not found.', 'NOT_FOUND', {
        snapshotId: artifacts.snapshotId,
        rootId,
      })
    }
    const references = await this.persistence.db
      .select({
        provider: this.persistence.tables.capsuleSnapshotResourceReferences.provider,
        kind: this.persistence.tables.capsuleSnapshotResourceReferences.kind,
        blueprintVolumeName: this.persistence.tables.capsuleSnapshotResourceReferences.blueprintVolumeName,
        sourceBranchResourceId: this.persistence.tables.capsuleSnapshotResourceReferences.sourceBranchResourceId,
        captureResourceId: this.persistence.tables.capsuleSnapshotResourceReferences.captureResourceId,
        project: this.persistence.tables.capsuleSnapshotResourceReferences.project,
        pool: this.persistence.tables.capsuleSnapshotResourceReferences.pool,
        sourceVolume: this.persistence.tables.capsuleSnapshotResourceReferences.sourceVolume,
        snapshotName: this.persistence.tables.capsuleSnapshotResourceReferences.snapshotName,
      })
      .from(this.persistence.tables.capsuleSnapshotResourceReferences)
      .where(
        and(
          eq(this.persistence.tables.capsuleSnapshotResourceReferences.snapshotId, artifacts.snapshotId),
          eq(this.persistence.tables.capsuleSnapshotResourceReferences.manifestRootId, manifestRootId),
        ),
      )
      .limit(2)
    if (references.length !== 1) {
      throw new IncusError('Committed artifact storage evidence is unavailable.', 'CONFLICT', {
        snapshotId: artifacts.snapshotId,
        rootId,
      })
    }
    const reference = references[0]!
    return CapsuleSnapshotResourceReferenceSchema.parse({
      provider: reference.provider,
      kind: reference.kind,
      artifactRootId: rootId,
      blueprintVolumeName: reference.blueprintVolumeName,
      sourceBranchResourceId: reference.sourceBranchResourceId,
      captureResourceId: reference.captureResourceId,
      project: reference.project,
      pool: reference.pool,
      sourceVolume: reference.sourceVolume,
      snapshotName: reference.snapshotName,
    })
  }

  private async header(ownerId: string, capsuleId: string, snapshotId: string) {
    const tables = this.persistence.tables
    const headers = await this.persistence.db
      .select({
        manifestId: tables.capsuleArtifactManifests.id,
        manifestSchemaVersion: tables.capsuleArtifactManifests.schemaVersion,
        manifestDigest: tables.capsuleArtifactManifests.digest,
        agentArtifactContentPolicy: tables.capsuleSnapshots.agentArtifactContentPolicy,
      })
      .from(tables.capsuleSnapshots)
      .innerJoin(tables.capsules, eq(tables.capsules.id, tables.capsuleSnapshots.capsuleId))
      .innerJoin(
        tables.capsuleArtifactManifests,
        eq(tables.capsuleArtifactManifests.snapshotId, tables.capsuleSnapshots.id),
      )
      .innerJoin(
        tables.capsuleSnapshotCaptureOperations,
        and(
          eq(tables.capsuleSnapshotCaptureOperations.snapshotId, tables.capsuleSnapshots.id),
          eq(tables.capsuleSnapshotCaptureOperations.sourceBranchId, tables.capsuleSnapshots.sourceBranchId),
          eq(tables.capsuleSnapshotCaptureOperations.sourceBranchName, tables.capsuleSnapshots.sourceBranchName),
          eq(
            tables.capsuleSnapshotCaptureOperations.sourceBranchResourceInventoryDigest,
            tables.capsuleSnapshots.sourceBranchResourceInventoryDigest,
          ),
          eq(
            tables.capsuleSnapshotCaptureOperations.blueprintSchemaVersion,
            tables.capsuleSnapshots.blueprintSchemaVersion,
          ),
          eq(tables.capsuleSnapshotCaptureOperations.blueprintName, tables.capsuleSnapshots.blueprintName),
          eq(tables.capsuleSnapshotCaptureOperations.blueprintDigest, tables.capsuleSnapshots.blueprintDigest),
          eq(tables.capsuleSnapshotCaptureOperations.blueprintPin, tables.capsuleSnapshots.blueprintPin),
          eq(tables.capsuleSnapshotCaptureOperations.rootfsImagePin, tables.capsuleSnapshots.rootfsImagePin),
          eq(
            tables.capsuleSnapshotCaptureOperations.capturePolicySchemaVersion,
            tables.capsuleSnapshots.capturePolicySchemaVersion,
          ),
          eq(tables.capsuleSnapshotCaptureOperations.capturePolicyDigest, tables.capsuleSnapshots.capturePolicyDigest),
          eq(tables.capsuleSnapshotCaptureOperations.capturePolicyPin, tables.capsuleSnapshots.capturePolicyPin),
          eq(tables.capsuleSnapshotCaptureOperations.requestedMode, tables.capsuleSnapshots.mode),
          eq(
            tables.capsuleSnapshotCaptureOperations.agentArtifactContentPolicy,
            tables.capsuleSnapshots.agentArtifactContentPolicy,
          ),
        ),
      )
      .innerJoin(
        tables.capsuleOperations,
        and(
          eq(tables.capsuleOperations.id, tables.capsuleSnapshotCaptureOperations.operationId),
          eq(tables.capsuleOperations.ownerId, ownerId),
          eq(tables.capsuleOperations.capsuleId, tables.capsuleSnapshots.capsuleId),
          eq(tables.capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
          eq(tables.capsuleOperations.status, CapsuleOperationStatus.COMPLETED),
        ),
      )
      .where(
        and(
          eq(tables.capsuleSnapshots.id, snapshotId),
          eq(tables.capsuleSnapshots.capsuleId, capsuleId),
          eq(tables.capsules.id, capsuleId),
          eq(tables.capsules.ownerId, ownerId),
          isNull(tables.capsuleSnapshots.archivedAt),
        ),
      )
      .limit(2)
    if (headers.length === 0) {
      throw new IncusError('Committed snapshot was not found.', 'NOT_FOUND', {
        snapshotId,
      })
    }
    if (headers.length !== 1) {
      throw new IncusError('Committed snapshot evidence is inconsistent.', 'CONFLICT', {
        snapshotId,
      })
    }
    return headers[0]!
  }

  private async roots(manifestId: string) {
    const roots = await this.persistence.db
      .select({
        id: this.persistence.tables.capsuleArtifactManifestRoots.id,
        rootId: this.persistence.tables.capsuleArtifactManifestRoots.rootId,
        logicalPath: this.persistence.tables.capsuleArtifactManifestRoots.logicalPath,
      })
      .from(this.persistence.tables.capsuleArtifactManifestRoots)
      .where(eq(this.persistence.tables.capsuleArtifactManifestRoots.manifestId, manifestId))
      .orderBy(asc(this.persistence.tables.capsuleArtifactManifestRoots.rootId))
      .limit(MAX_COMMITTED_MANIFEST_ROOTS + 1)
    if (roots.length === 0 || roots.length > MAX_COMMITTED_MANIFEST_ROOTS) {
      throw new IncusError('Committed artifact manifest root evidence exceeds agent read limits.', 'CONFLICT', {
        manifestId,
      })
    }
    return roots
  }

  private async entries(manifestId: string) {
    const entries = await this.persistence.db
      .select({
        manifestRootId: this.persistence.tables.capsuleArtifactEntries.manifestRootId,
        logicalPath: this.persistence.tables.capsuleArtifactEntries.logicalPath,
        type: this.persistence.tables.capsuleArtifactEntries.type,
        mode: this.persistence.tables.capsuleArtifactEntries.mode,
        uid: this.persistence.tables.capsuleArtifactEntries.uid,
        gid: this.persistence.tables.capsuleArtifactEntries.gid,
        modifiedAt: this.persistence.tables.capsuleArtifactEntries.modifiedAt,
        size: this.persistence.tables.capsuleArtifactEntries.size,
        contentDigest: this.persistence.tables.capsuleArtifactEntries.contentDigest,
      })
      .from(this.persistence.tables.capsuleArtifactEntries)
      .innerJoin(
        this.persistence.tables.capsuleArtifactManifestRoots,
        eq(
          this.persistence.tables.capsuleArtifactManifestRoots.id,
          this.persistence.tables.capsuleArtifactEntries.manifestRootId,
        ),
      )
      .where(eq(this.persistence.tables.capsuleArtifactManifestRoots.manifestId, manifestId))
      .orderBy(
        asc(this.persistence.tables.capsuleArtifactEntries.manifestRootId),
        asc(this.persistence.tables.capsuleArtifactEntries.logicalPath),
      )
      .limit(MAX_COMMITTED_MANIFEST_ENTRIES + 1)

    if (entries.length === 0 || entries.length > MAX_COMMITTED_MANIFEST_ENTRIES) {
      throw new IncusError('Committed artifact manifest entry evidence exceeds agent read limits.', 'CONFLICT', {
        manifestId,
      })
    }

    return entries
  }
}

export type { AgentSnapshotArtifactEntry, AgentSnapshotArtifactRoot }
