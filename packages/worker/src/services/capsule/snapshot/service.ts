import {
  CapsuleSnapshotLimitationsSchema,
  CapsuleSnapshotListOutputSchema,
  createCapsuleBlueprintReference,
  verifyCapsuleBlueprintPin,
  verifyCapsuleSnapshotCapturePolicyPin,
  type AgentContextSnapshot,
  type AgentSnapshotArtifactContentRequest,
  type AgentSnapshotArtifactContentOutput,
  type AgentSnapshotManifestEntries,
  type AgentSnapshotManifestEntriesOutput,
  type AgentSnapshotManifestRoots,
  type AgentSnapshotManifestRootsOutput,
  type CapsuleSnapshotListOutput,
} from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleSnapshotReadService } from './read'
import type { CapsuleSnapshotSelector } from './select'
import type { CapsuleSnapshotListOptions, CapsuleSnapshotRecord } from './types'
import type { CapsuleSnapshotStore } from './store'

function toIsoTimestamp(value: Date, field: string, snapshotId: string): string {
  if (!(value instanceof Date)) {
    throw new IncusError('Capsule snapshot contains a non-Date timestamp.', 'API_ERROR', {
      snapshotId,
      field,
      valueType: typeof value,
    })
  }
  const timestamp = value.getTime()
  if (!Number.isFinite(timestamp)) {
    throw new IncusError('Capsule snapshot contains an invalid timestamp.', 'API_ERROR', {
      snapshotId,
      field,
    })
  }
  return value.toISOString()
}

/**
 * Maps committed persistence rows into client-safe snapshot history and
 * immutable agent-read contracts.
 */
export class CapsuleSnapshotService {
  constructor(
    private readonly snapshots: CapsuleSnapshotStore,
    private readonly reader: CapsuleSnapshotReadService,
    private readonly selector: CapsuleSnapshotSelector,
  ) {}

  public async list(
    ownerId: string,
    capsuleId: string,
    options: CapsuleSnapshotListOptions = {},
  ): Promise<CapsuleSnapshotListOutput> {
    const snapshots = await this.snapshots.list(ownerId, capsuleId, options)
    return CapsuleSnapshotListOutputSchema.parse(snapshots.map(snapshot => this.summary(snapshot)))
  }

  public async select(ownerId: string, capsuleId: string, branchId?: string): Promise<AgentContextSnapshot | null> {
    return await this.selector.select(ownerId, capsuleId, branchId)
  }

  public async manifestRoots(
    ownerId: string,
    capsuleId: string,
    input: AgentSnapshotManifestRoots,
  ): Promise<AgentSnapshotManifestRootsOutput> {
    return await this.reader.manifestRoots(ownerId, capsuleId, input)
  }

  public async manifestEntries(
    ownerId: string,
    capsuleId: string,
    input: AgentSnapshotManifestEntries,
  ): Promise<AgentSnapshotManifestEntriesOutput> {
    return await this.reader.manifestEntries(ownerId, capsuleId, input)
  }

  public async artifactContent(
    ownerId: string,
    capsuleId: string,
    input: AgentSnapshotArtifactContentRequest,
  ): Promise<AgentSnapshotArtifactContentOutput> {
    return await this.reader.artifactContent(ownerId, capsuleId, input)
  }

  private summary(snapshot: CapsuleSnapshotRecord) {
    const blueprint = verifyCapsuleBlueprintPin(snapshot.blueprintPin)
    const capturePolicy = verifyCapsuleSnapshotCapturePolicyPin(snapshot.capturePolicyPin)
    if (
      blueprint.blueprint.schema_version !== snapshot.blueprintSchemaVersion ||
      blueprint.name !== snapshot.blueprintName ||
      blueprint.digest !== snapshot.blueprintDigest
    ) {
      throw new IncusError('Committed capsule snapshot Blueprint evidence is internally inconsistent.', 'API_ERROR', {
        snapshotId: snapshot.id,
        persistedSchemaVersion: snapshot.blueprintSchemaVersion,
        pinSchemaVersion: blueprint.blueprint.schema_version,
        persistedName: snapshot.blueprintName,
        pinName: blueprint.name,
        persistedDigest: snapshot.blueprintDigest,
        pinDigest: blueprint.digest,
      })
    }
    if (
      capturePolicy.schemaVersion !== snapshot.capturePolicySchemaVersion ||
      capturePolicy.digest !== snapshot.capturePolicyDigest ||
      capturePolicy.blueprintName !== blueprint.name ||
      capturePolicy.blueprintDigest !== blueprint.digest
    ) {
      throw new IncusError(
        'Committed capsule snapshot capture-policy evidence is internally inconsistent.',
        'API_ERROR',
        {
          snapshotId: snapshot.id,
          persistedSchemaVersion: snapshot.capturePolicySchemaVersion,
          pinSchemaVersion: capturePolicy.schemaVersion,
          persistedDigest: snapshot.capturePolicyDigest,
          pinDigest: capturePolicy.digest,
        },
      )
    }
    const limitations = CapsuleSnapshotLimitationsSchema.parse(snapshot.limitations)
    return {
      id: snapshot.id,
      capsuleId: snapshot.capsuleId,
      sourceBranchId: snapshot.sourceBranchId,
      sourceBranchName: snapshot.sourceBranchName,
      sourceBranchResourceInventoryDigest: snapshot.sourceBranchResourceInventoryDigest,
      blueprint: createCapsuleBlueprintReference(blueprint),
      capturePolicy: {
        schemaVersion: capturePolicy.schemaVersion,
        digest: capturePolicy.digest,
      },
      artifactManifest: {
        schemaVersion: snapshot.artifactManifestSchemaVersion,
        digest: snapshot.artifactManifestDigest,
      },
      agentArtifactContentPolicy: snapshot.agentArtifactContentPolicy,
      assurance: {
        mode: snapshot.mode,
        limitations,
      },
      createdAt: toIsoTimestamp(snapshot.createdAt, 'createdAt', snapshot.id),
      archivedAt: snapshot.archivedAt === null ? null : toIsoTimestamp(snapshot.archivedAt, 'archivedAt', snapshot.id),
    }
  }
}
