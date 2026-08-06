import type { AgentSnapshotRead, AgentSnapshotReadOutput } from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Reads bounded immutable manifest evidence or owner-authorized artifact text
 * from one exact committed snapshot selected by the host API credential scope.
 */
export const qilnReadTool = {
  name: 'qiln_read',
  async execute(client: QilnAgentClient, input: AgentSnapshotRead): Promise<AgentSnapshotReadOutput> {
    return await client.read(input)
  },
} as const satisfies QilnAgentTool<AgentSnapshotRead, AgentSnapshotReadOutput>
