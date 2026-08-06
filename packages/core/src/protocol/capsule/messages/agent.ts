import { z } from 'zod'
import { AgentActorSchema, AgentSnapshotReadInputSchema, AgentSnapshotReadOutputSchema } from '../../../schemas/agent'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from './definitions'

const CAPSULE_AGENT_READ_TIMEOUT_MS = 30_000

/**
 * The host publishes this command only after API-key authentication derives the
 * requester, agent actor, capsule scope, and exact snapshot selector. The
 * Worker must still prove committed snapshot lineage before returning metadata
 * or artifact content.
 */
export const CapsuleAgentReadCommandName = {
  AGENT_READ: 'capsule.agent.read',
} as const

export type CapsuleAgentReadCommandName = (typeof CapsuleAgentReadCommandName)[keyof typeof CapsuleAgentReadCommandName]

export const CapsuleAgentReadCommandNameValues = [CapsuleAgentReadCommandName.AGENT_READ] as const

export const CapsuleAgentReadInputSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: AgentActorSchema,
    capsuleId: z.uuid(),
    read: AgentSnapshotReadInputSchema,
  })
  .strict()

export const CapsuleAgentReadOutputSchema = AgentSnapshotReadOutputSchema

export type CapsuleAgentReadInput = input<typeof CapsuleAgentReadInputSchema>
export type CapsuleAgentRead = output<typeof CapsuleAgentReadInputSchema>
export type CapsuleAgentReadOutput = output<typeof CapsuleAgentReadOutputSchema>

export const CapsuleAgentReadCommandDefinitions = {
  [CapsuleAgentReadCommandName.AGENT_READ]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleAgentReadCommandName.AGENT_READ,
    inputSchema: CapsuleAgentReadInputSchema,
    outputSchema: CapsuleAgentReadOutputSchema,
    timeoutMs: CAPSULE_AGENT_READ_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleAgentRead) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleAgentReadCommandName, CapsuleCommandDefinition>
