import { and, eq, ne } from 'drizzle-orm'
import {
  AgentBranchContextSchema,
  AgentGetContextOutputSchema,
  CapsuleAgentReadCommandName,
  type AgentBranchContext,
  type AgentGetContext,
  type AgentGetContextOutput,
  type CapsuleChannel,
} from '@qiln/core/server'
import { capsuleBranches } from '@server/db/schema'
import { resolveAgentAuthority } from '@server/agent/authority'
import type { Database } from '@server/db'

export { AgentUnauthorizedError } from '@server/agent/authority'

export class AgentBranchNotFoundError extends Error {
  constructor() {
    super('Branch not found.')
    this.name = 'AgentBranchNotFoundError'
  }
}

function hasBranchSelector(input: AgentGetContext): boolean {
  return input.branchId !== undefined || input.branchName !== undefined
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
 * Resolves API-key authority and an optional branch selector through host-owned
 * credential and capsule persistence, then asks the Worker for one exact
 * immutable manifest-readable snapshot reference.
 */
export async function resolveAgentContext(
  db: Database,
  channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentGetContext,
): Promise<AgentGetContextOutput> {
  const authority = await resolveAgentAuthority(db, apiKey)
  if (authority.capsule === null) {
    if (hasBranchSelector(input)) {
      throw new AgentBranchNotFoundError()
    }
    return AgentGetContextOutputSchema.parse({
      requester: authority.requester,
      agent: authority.agent,
      capsule: null,
      branch: null,
      snapshot: null,
    })
  }
  const selectedBranch = hasBranchSelector(input)
    ? await branch(db, authority.requester.id, authority.capsule.capsuleId, input)
    : null
  const snapshot = await channel.command(CapsuleAgentReadCommandName.SNAPSHOT, {
    target: {
      type: 'owner',
      id: authority.requester.id,
    },
    actor: authority.agent,
    capsuleId: authority.capsule.capsuleId,
    ...(selectedBranch === null ? {} : { branchId: selectedBranch.id }),
  })
  return AgentGetContextOutputSchema.parse({
    requester: authority.requester,
    agent: authority.agent,
    capsule: authority.capsule,
    branch: selectedBranch,
    snapshot,
  })
}
