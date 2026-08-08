import { and, eq, isNull } from 'drizzle-orm'
import {
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
  CapsuleAgentReadCommandName,
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotAgentArtifactContentPolicy,
  type AgentActor,
  type AgentSnapshotArtifactContentRequest,
  type AgentSnapshotArtifactContentOutput,
  type AgentSnapshotManifestEntries,
  type AgentSnapshotManifestEntriesOutput,
  type AgentSnapshotManifestRoots,
  type AgentSnapshotManifestRootsOutput,
  type CapsuleChannel,
  type CapsuleSnapshotAgentArtifactContentPolicyValue,
} from '@qiln/core/server'
import {
  capsuleArtifactManifests,
  capsuleOperations,
  capsuleSnapshotCaptureOperations,
  capsuleSnapshots,
} from '@server/db/schema'
import { resolveAgentAuthority } from '@server/agent/authority'
import type { Database } from '@server/db'

export class AgentSnapshotNotFoundError extends Error {
  constructor() {
    super('Snapshot not found.')
    this.name = 'AgentSnapshotNotFoundError'
  }
}

export class AgentArtifactContentDeniedError extends Error {
  constructor() {
    super('Artifact content is not available for this snapshot.')
    this.name = 'AgentArtifactContentDeniedError'
  }
}

interface AuthorizedSnapshotScope {
  requesterId: string
  agent: AgentActor
  capsuleId: string
}

interface CommittedSnapshot {
  agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicyValue
}

async function scope(db: Database, apiKey: string | null): Promise<AuthorizedSnapshotScope> {
  const authority = await resolveAgentAuthority(db, apiKey)
  if (authority.capsule === null) {
    throw new AgentSnapshotNotFoundError()
  }
  return {
    requesterId: authority.requester.id,
    agent: authority.agent,
    capsuleId: authority.capsule.capsuleId,
  }
}

async function snapshot(
  db: Database,
  requesterId: string,
  capsuleId: string,
  snapshotId: string,
): Promise<CommittedSnapshot> {
  const [record] = await db
    .select({
      agentArtifactContentPolicy: capsuleSnapshots.agentArtifactContentPolicy,
    })
    .from(capsuleSnapshots)
    .innerJoin(capsuleArtifactManifests, eq(capsuleArtifactManifests.snapshotId, capsuleSnapshots.id))
    .innerJoin(capsuleSnapshotCaptureOperations, eq(capsuleSnapshotCaptureOperations.snapshotId, capsuleSnapshots.id))
    .innerJoin(
      capsuleOperations,
      and(
        eq(capsuleOperations.id, capsuleSnapshotCaptureOperations.operationId),
        eq(capsuleOperations.type, CapsuleOperationType.SNAPSHOT_CAPTURE),
        eq(capsuleOperations.status, CapsuleOperationStatus.COMPLETED),
        eq(capsuleOperations.ownerId, requesterId),
        eq(capsuleOperations.capsuleId, capsuleSnapshots.capsuleId),
      ),
    )
    .where(
      and(
        eq(capsuleSnapshots.id, snapshotId),
        eq(capsuleSnapshots.capsuleId, capsuleId),
        isNull(capsuleSnapshots.archivedAt),
      ),
    )
    .limit(1)

  if (!record) {
    throw new AgentSnapshotNotFoundError()
  }

  return record
}

/**
 * Resolves exact immutable manifest-root reads through host-owned credential
 * scope before forwarding the bounded read to the Worker control plane.
 */
export async function resolveAgentManifestRoots(
  db: Database,
  channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentSnapshotManifestRoots,
): Promise<AgentSnapshotManifestRootsOutput> {
  const authorized = await scope(db, apiKey)
  await snapshot(db, authorized.requesterId, authorized.capsuleId, input.snapshotId)

  return await channel.command(CapsuleAgentReadCommandName.MANIFEST_ROOTS, {
    target: {
      type: 'owner',
      id: authorized.requesterId,
    },
    actor: authorized.agent,
    capsuleId: authorized.capsuleId,
    snapshotId: input.snapshotId,
    ...(input.afterRootId === undefined ? {} : { afterRootId: input.afterRootId }),
    limit: input.limit,
  })
}

/**
 * Resolves exact immutable manifest-entry reads through host-owned credential
 * scope before forwarding the bounded read to the Worker control plane.
 */
export async function resolveAgentManifestEntries(
  db: Database,
  channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentSnapshotManifestEntries,
): Promise<AgentSnapshotManifestEntriesOutput> {
  const authorized = await scope(db, apiKey)
  await snapshot(db, authorized.requesterId, authorized.capsuleId, input.snapshotId)

  return await channel.command(CapsuleAgentReadCommandName.MANIFEST_ENTRIES, {
    target: {
      type: 'owner',
      id: authorized.requesterId,
    },
    actor: authorized.agent,
    capsuleId: authorized.capsuleId,
    snapshotId: input.snapshotId,
    rootId: input.rootId,
    ...(input.afterLogicalPath === undefined ? {} : { afterLogicalPath: input.afterLogicalPath }),
    limit: input.limit,
  })
}

/**
 * Resolves one exact immutable artifact-content read through host-owned
 * credential scope before forwarding it to the Worker control plane.
 */
export async function resolveAgentArtifactContent(
  db: Database,
  channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentSnapshotArtifactContentRequest,
): Promise<AgentSnapshotArtifactContentOutput> {
  const authorized = await scope(db, apiKey)
  const committed = await snapshot(db, authorized.requesterId, authorized.capsuleId, input.snapshotId)

  if (committed.agentArtifactContentPolicy !== CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED) {
    throw new AgentArtifactContentDeniedError()
  }

  return await channel.command(CapsuleAgentReadCommandName.ARTIFACT_CONTENT, {
    target: {
      type: 'owner',
      id: authorized.requesterId,
    },
    actor: authorized.agent,
    capsuleId: authorized.capsuleId,
    snapshotId: input.snapshotId,
    rootId: input.rootId,
    logicalPath: input.logicalPath,
  })
}

export {
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
}
