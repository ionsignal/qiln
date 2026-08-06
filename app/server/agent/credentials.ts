import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import { createAgentKey } from '@server/agent/key'
import { agentCredentials, capsules } from '@server/db/schema'
import type { Database } from '@server/db'

export class AgentCredentialNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentCredentialNotFoundError'
  }
}

export interface AgentCredentialSummary {
  id: string
  agentActorId: string
  capsuleId: string | null
  isActive: boolean
  createdAt: Date
}

export interface IssuedAgentCredential extends Omit<AgentCredentialSummary, 'capsuleId' | 'isActive'> {
  capsuleId: string
  isActive: true
  apiKey: string
}

/**
 * Owns host-authenticated administration of external-agent credentials.
 *
 * API keys are generated once during issuance. Their plaintext value never
 * enters durable persistence and is never returned by list or revoke paths.
 */
export class AgentCredentialService {
  constructor(private readonly db: Database) {}

  public async issue(ownerId: string, capsuleId: string): Promise<IssuedAgentCredential> {
    const credentialId = randomUUID()
    const agentActorId = randomUUID()
    const generatedKey = await createAgentKey(credentialId)
    return await this.db.transaction(async tx => {
      const [capsule] = await tx
        .select({
          id: capsules.id,
        })
        .from(capsules)
        .where(and(eq(capsules.id, capsuleId), eq(capsules.ownerId, ownerId)))
        .for('update')
        .limit(1)

      if (!capsule) {
        throw new AgentCredentialNotFoundError('Capsule not found or access denied.')
      }
      const [credential] = await tx
        .insert(agentCredentials)
        .values({
          id: credentialId,
          keyHash: generatedKey.keyHash,
          agentActorId,
          requestedByUserId: ownerId,
          capsuleId: capsule.id,
          isActive: true,
        })
        .returning({
          id: agentCredentials.id,
          agentActorId: agentCredentials.agentActorId,
          capsuleId: agentCredentials.capsuleId,
          isActive: agentCredentials.isActive,
          createdAt: agentCredentials.createdAt,
        })
      if (
        !credential ||
        credential.capsuleId === null ||
        credential.isActive !== true ||
        credential.id !== credentialId ||
        credential.agentActorId !== agentActorId
      ) {
        throw new Error('Failed to persist the scoped agent credential.')
      }
      return {
        ...credential,
        capsuleId: credential.capsuleId,
        isActive: true,
        apiKey: generatedKey.key,
      }
    })
  }

  public async list(ownerId: string): Promise<AgentCredentialSummary[]> {
    return await this.db
      .select({
        id: agentCredentials.id,
        agentActorId: agentCredentials.agentActorId,
        capsuleId: agentCredentials.capsuleId,
        isActive: agentCredentials.isActive,
        createdAt: agentCredentials.createdAt,
      })
      .from(agentCredentials)
      .where(eq(agentCredentials.requestedByUserId, ownerId))
      .orderBy(desc(agentCredentials.createdAt), asc(agentCredentials.id))
  }

  public async revoke(ownerId: string, credentialId: string): Promise<AgentCredentialSummary> {
    const [credential] = await this.db
      .update(agentCredentials)
      .set({
        isActive: false,
      })
      .where(and(eq(agentCredentials.id, credentialId), eq(agentCredentials.requestedByUserId, ownerId)))
      .returning({
        id: agentCredentials.id,
        agentActorId: agentCredentials.agentActorId,
        capsuleId: agentCredentials.capsuleId,
        isActive: agentCredentials.isActive,
        createdAt: agentCredentials.createdAt,
      })

    if (!credential) {
      throw new AgentCredentialNotFoundError('Agent credential not found or access denied.')
    }
    return credential
  }
}
