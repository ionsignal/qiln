import { and, eq, ne } from 'drizzle-orm'
import {
  AgentActorSchema,
  AgentBranchContextSchema,
  AgentGetContextOutputSchema,
  AgentRequesterSchema,
  CapsuleLifecycleStateSchema,
  getAgentDevelopmentEligibility,
  type AgentBranchContext,
  type AgentGetContext,
  type AgentGetContextOutput,
} from '@qiln/core/server'
import { agentCredentials, capsuleBranches, capsules, users } from '@server/db/schema'
import { consumeUnknownAgentKeyVerification, parseAgentKey, verifyAgentKeyHash } from '@server/agent/key'
import type { Database } from '@server/db'

export class AgentUnauthorizedError extends Error {
  constructor() {
    super('Unauthorized agent credential.')
    this.name = 'AgentUnauthorizedError'
  }
}

export class AgentBranchNotFoundError extends Error {
  constructor() {
    super('Branch not found.')
    this.name = 'AgentBranchNotFoundError'
  }
}

interface AgentAuthority {
  requester: {
    id: string
    username: string
  }
  agent: {
    type: 'agent'
    id: string
  }
  capsule: ReturnType<typeof CapsuleLifecycleStateSchema.parse> | null
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

function hasBranchSelector(input: AgentGetContext): boolean {
  return input.branchId !== undefined || input.branchName !== undefined
}

async function authorize(db: Database, apiKey: string | null): Promise<AgentAuthority> {
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

async function branch(
  db: Database,
  ownerId: string,
  capsuleId: string,
  input: AgentGetContext,
): Promise<AgentBranchContext> {
  const selector =
    input.branchId !== undefined ? eq(capsuleBranches.id, input.branchId) : eq(capsuleBranches.name, input.branchName!)
  const [selected] = await db
    .select({
      id: capsuleBranches.id,
      name: capsuleBranches.name,
      isRootBranch: capsuleBranches.isRootBranch,
      status: capsuleBranches.status,
    })
    .from(capsuleBranches)
    .where(
      and(
        selector,
        eq(capsuleBranches.ownerId, ownerId),
        eq(capsuleBranches.capsuleId, capsuleId),
        ne(capsuleBranches.status, 'destroyed'),
      ),
    )
    .limit(1)
  if (!selected) {
    throw new AgentBranchNotFoundError()
  }
  return AgentBranchContextSchema.parse(selected)
}

/**
 * Resolves API-key authority and an optional editable branch selector through
 * host-owned credential and capsule persistence.
 */
export async function resolveAgentContext(
  db: Database,
  apiKey: string | null,
  input: AgentGetContext,
): Promise<AgentGetContextOutput> {
  const authority = await authorize(db, apiKey)
  if (authority.capsule === null) {
    if (hasBranchSelector(input)) {
      throw new AgentBranchNotFoundError()
    }
    return AgentGetContextOutputSchema.parse({
      requester: authority.requester,
      agent: authority.agent,
      capsule: null,
      branch: null,
      ...getAgentDevelopmentEligibility(null, null),
    })
  }
  const selectedBranch = hasBranchSelector(input)
    ? await branch(db, authority.requester.id, authority.capsule.capsuleId, input)
    : null
  return AgentGetContextOutputSchema.parse({
    requester: authority.requester,
    agent: authority.agent,
    capsule: authority.capsule,
    branch: selectedBranch,
    ...getAgentDevelopmentEligibility(authority.capsule, selectedBranch),
  })
}
