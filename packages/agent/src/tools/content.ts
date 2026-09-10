import {
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  type AgentSnapshotArtifactContentRequest,
  type AgentSnapshotArtifactContentOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Retains the artifact-content capability as an explicit unavailable response.
 * Null content must not be interpreted as a real empty file.
 */
export const qilnReadArtifactContentTool = {
  name: 'qiln_read_artifact_content',
  description:
    'Snapshot artifact-content reads are temporarily unavailable. This compatibility tool accepts the existing snapshotId, rootId, and logicalPath selectors, then returns available: false and content: null. It does not prove the snapshot or artifact exists and does not return an empty file. This tool cannot read editable branches, live runtimes, Host files, provider storage, credentials, or secret stores.',
  inputSchema: AgentSnapshotArtifactContentRequestSchema,
  outputSchema: AgentSnapshotArtifactContentOutputSchema,
  async execute(
    client: QilnAgentClient,
    input: AgentSnapshotArtifactContentRequest,
  ): Promise<AgentSnapshotArtifactContentOutput> {
    return await client.artifactContent(input)
  },
} as const satisfies QilnAgentTool<AgentSnapshotArtifactContentRequest, AgentSnapshotArtifactContentOutput>
