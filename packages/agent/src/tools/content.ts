import {
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  type AgentSnapshotArtifactContentRequest,
  type AgentSnapshotArtifactContentOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Reads one bounded UTF-8 regular-file artifact only when immutable snapshot
 * policy explicitly permits owner-authorized unreviewed content access.
 */
export const qilnReadArtifactContentTool = {
  name: 'qiln_read_artifact_content',
  description:
    'Read one bounded UTF-8 regular-file artifact from exact immutable committed snapshot evidence. Use an exact rootId and logicalPath returned by the manifest-read tools. Content is denied unless the snapshot was captured with owner_authorized_unreviewed access; that policy is unsafe-by-name and does not prove the file is free of secret material. This tool cannot read directories, editable branches, live runtimes, Host files, provider storage, credentials, or secret stores.',
  inputSchema: AgentSnapshotArtifactContentRequestSchema,
  outputSchema: AgentSnapshotArtifactContentOutputSchema,
  async execute(
    client: QilnAgentClient,
    input: AgentSnapshotArtifactContentRequest,
  ): Promise<AgentSnapshotArtifactContentOutput> {
    return await client.artifactContent(input)
  },
} as const satisfies QilnAgentTool<AgentSnapshotArtifactContentRequest, AgentSnapshotArtifactContentOutput>
