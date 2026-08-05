import type { AgentGetContext, AgentGetContextOutput } from '@qiln/core/client'
import type { QilnAgentClient } from '../client'

export interface QilnAgentTool<TInput, TOutput> {
  readonly name: string
  execute(client: QilnAgentClient, input: TInput): Promise<TOutput>
}

/**
 * Resolves host-derived agent identity, authorized capsule scope, optional
 * branch selection, and current development eligibility.
 */
export const qilnGetContextTool = {
  name: 'qiln_get_context',
  async execute(client: QilnAgentClient, input: AgentGetContext): Promise<AgentGetContextOutput> {
    return await client.getContext(input)
  },
} as const satisfies QilnAgentTool<AgentGetContext, AgentGetContextOutput>
