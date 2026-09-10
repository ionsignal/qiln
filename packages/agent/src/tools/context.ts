import {
  AgentGetContextInputSchema,
  AgentGetContextOutputSchema,
  type AgentGetContext,
  type AgentGetContextOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Resolves Host-derived agent identity, authorized capsule scope, and optional
 * branch selection. Snapshot selection is temporarily unavailable.
 */
export const qilnGetContextTool = {
  name: 'qiln_get_context',
  description:
    'Resolve Host-derived agent context. Optionally select one branch by branchId or branchName. ' +
    'The Host derives requester identity, agent actor identity, capsule scope, lifecycle, and branch ' +
    'ownership; do not supply authority fields. Snapshot selection is temporarily unavailable, so ' +
    'snapshot is always null. This tool does not read artifacts or inspect live runtimes.',
  inputSchema: AgentGetContextInputSchema,
  outputSchema: AgentGetContextOutputSchema,
  async execute(client: QilnAgentClient, input: AgentGetContext): Promise<AgentGetContextOutput> {
    return await client.getContext(input)
  },
} as const satisfies QilnAgentTool<AgentGetContext, AgentGetContextOutput>
