import {
  AgentGetContextInputSchema,
  AgentGetContextOutputSchema,
  type AgentGetContext,
  type AgentGetContextOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Resolves Host-derived agent identity, authorized capsule scope, optional
 * branch selection, and an exact immutable snapshot reference for later reads.
 */
export const qilnGetContextTool = {
  name: 'qiln_get_context',
  description:
    'Resolve Host-derived agent context. Optionally select one branch by branchId or branchName. ' +
    'The Host derives requester identity, agent actor identity, capsule scope, lifecycle, and branch ' +
    'ownership; do not supply authority fields. When snapshot is present, it is one exact immutable ' +
    'committed snapshot for later manifest and artifact reads, not a mutable latest pointer. The ' +
    'selection explains whether Qiln chose the newest readable capsule snapshot, the newest readable ' +
    'capture from the selected branch, or that branch’s completed fork base.',
  inputSchema: AgentGetContextInputSchema,
  outputSchema: AgentGetContextOutputSchema,
  async execute(client: QilnAgentClient, input: AgentGetContext): Promise<AgentGetContextOutput> {
    return await client.getContext(input)
  },
} as const satisfies QilnAgentTool<AgentGetContext, AgentGetContextOutput>
