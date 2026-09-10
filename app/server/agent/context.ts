import { and, eq, ne } from 'drizzle-orm'
import {
  AgentBranchContextSchema,
  AgentGetContextOutputSchema,
  type AgentBranchContext,
  type AgentGetContext,
  type AgentGetContextOutput,
  type CapsuleChannel,
} from '@qiln/core/server'
import { capsuleBranches } from '@/db/capsule'
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

async function selectBranch(
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
 * credential and capsule persistence.
 *
 * Snapshot selection is temporarily unavailable. The channel parameter remains
 * for Host integration compatibility, but no Worker command is dispatched.
 */
export async function resolveAgentContext(
  db: Database,
  _channel: CapsuleChannel,
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
    ? await selectBranch(db, authority.requester.id, authority.capsule.capsuleId, input)
    : null
  return AgentGetContextOutputSchema.parse({
    requester: authority.requester,
    agent: authority.agent,
    capsule: authority.capsule,
    branch: selectedBranch,
    snapshot: null,
  })
}
