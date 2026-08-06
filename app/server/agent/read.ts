import { and, eq, isNull } from 'drizzle-orm'
import {
  AgentSnapshotReadMode,
  CapsuleAgentReadCommandName,
  CapsuleOperationStatus,
  CapsuleOperationType,
  CapsuleSnapshotAgentArtifactContentPolicy,
  type AgentSnapshotRead,
  type AgentSnapshotReadOutput,
  type CapsuleChannel,
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

/**
 * Resolves an exact immutable snapshot selector through host-owned credential
 * scope before forwarding the bounded read to the Worker control plane.
 */
export async function resolveAgentRead(
  db: Database,
  channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentSnapshotRead,
): Promise<AgentSnapshotReadOutput> {
  const authority = await resolveAgentAuthority(db, apiKey)
  if (authority.capsule === null) {
    throw new AgentSnapshotNotFoundError()
  }
  const [snapshot] = await db
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
        eq(capsuleOperations.ownerId, authority.requester.id),
        eq(capsuleOperations.capsuleId, capsuleSnapshots.capsuleId),
      ),
    )
    .where(
      and(
        eq(capsuleSnapshots.id, input.snapshotId),
        eq(capsuleSnapshots.capsuleId, authority.capsule.capsuleId),
        isNull(capsuleSnapshots.archivedAt),
      ),
    )
    .limit(1)
  if (!snapshot) {
    throw new AgentSnapshotNotFoundError()
  }
  if (
    input.mode === AgentSnapshotReadMode.CONTENT &&
    snapshot.agentArtifactContentPolicy !== CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED
  ) {
    throw new AgentArtifactContentDeniedError()
  }
  return await channel.command(CapsuleAgentReadCommandName.AGENT_READ, {
    target: {
      type: 'owner',
      id: authority.requester.id,
    },
    actor: authority.agent,
    capsuleId: authority.capsule.capsuleId,
    read: input,
  })
}
