import { eq } from 'drizzle-orm'
import {
  AgentActorSchema,
  AgentRequesterSchema,
  CapsuleLifecycleStateSchema,
  type CapsuleLifecycleState,
} from '@qiln/core/server'
import { agentCredentials, capsules, users } from '@server/db/schema'
import { consumeUnknownAgentKeyVerification, parseAgentKey, verifyAgentKeyHash } from '@server/agent/key'
import type { Database } from '@server/db'

export class AgentUnauthorizedError extends Error {
  constructor() {
    super('Unauthorized agent credential.')
    this.name = 'AgentUnauthorizedError'
  }
}

export interface AgentAuthority {
  requester: {
    id: string
    username: string
  }
  agent: {
    type: 'agent'
    id: string
  }
  capsule: CapsuleLifecycleState | null
}

function toIsoTimestamp(value: Date | null, field: string): string | null {
  if (value === null) {
    return null
  }
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Agent credential capsule contains an invalid '${field}' timestamp.`)
  }
  return value.toISOString()
}

/**
 * Resolves API-key identity and optional capsule scope exclusively from
 * host-owned credential and aggregate persistence.
 */
export async function resolveAgentAuthority(db: Database, apiKey: string | null): Promise<AgentAuthority> {
  if (apiKey === null) {
    await consumeUnknownAgentKeyVerification()
    throw new AgentUnauthorizedError()
  }
  const parsedKey = parseAgentKey(apiKey)
  if (!parsedKey) {
    await consumeUnknownAgentKeyVerification()
    throw new AgentUnauthorizedError()
  }
  const [credential] = await db
    .select({
      keyHash: agentCredentials.keyHash,
      agentActorId: agentCredentials.agentActorId,
      requestedByUserId: agentCredentials.requestedByUserId,
      capsuleId: agentCredentials.capsuleId,
      isActive: agentCredentials.isActive,
      requesterId: users.id,
      requesterUsername: users.username,
      scopedCapsuleId: capsules.id,
      scopedCapsuleOwnerId: capsules.ownerId,
      scopedCapsuleLifecycleStatus: capsules.lifecycleStatus,
      scopedCapsuleArchivedAt: capsules.archivedAt,
      scopedCapsuleDestroyedAt: capsules.destroyedAt,
    })
    .from(agentCredentials)
    .innerJoin(users, eq(users.id, agentCredentials.requestedByUserId))
    .leftJoin(capsules, eq(capsules.id, agentCredentials.capsuleId))
    .where(eq(agentCredentials.id, parsedKey.credentialId))
    .limit(1)
  const verified = await verifyAgentKeyHash(credential?.keyHash ?? null, parsedKey.secret)
  if (!credential || !verified || !credential.isActive) {
    throw new AgentUnauthorizedError()
  }
  const requester = AgentRequesterSchema.safeParse({
    id: credential.requesterId,
    username: credential.requesterUsername,
  })
  const agent = AgentActorSchema.safeParse({
    type: 'agent',
    id: credential.agentActorId,
  })
  if (!requester.success || !agent.success || credential.requestedByUserId !== credential.requesterId) {
    throw new AgentUnauthorizedError()
  }
  if (credential.capsuleId === null) {
    return {
      requester: requester.data,
      agent: agent.data,
      capsule: null,
    }
  }
  if (
    credential.scopedCapsuleId === null ||
    credential.scopedCapsuleOwnerId === null ||
    credential.scopedCapsuleLifecycleStatus === null ||
    credential.scopedCapsuleId !== credential.capsuleId ||
    credential.scopedCapsuleOwnerId !== credential.requestedByUserId
  ) {
    throw new AgentUnauthorizedError()
  }
  return {
    requester: requester.data,
    agent: agent.data,
    capsule: CapsuleLifecycleStateSchema.parse({
      capsuleId: credential.scopedCapsuleId,
      lifecycleStatus: credential.scopedCapsuleLifecycleStatus,
      archivedAt: toIsoTimestamp(credential.scopedCapsuleArchivedAt, 'archivedAt'),
      destroyedAt: toIsoTimestamp(credential.scopedCapsuleDestroyedAt, 'destroyedAt'),
    }),
  }
}
