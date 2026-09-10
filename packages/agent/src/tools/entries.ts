import {
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  type AgentSnapshotManifestEntries,
  type AgentSnapshotManifestEntriesOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Retains the manifest-entry capability as an explicit unavailable response
 * while agent snapshot reads are disabled.
 */
export const qilnReadManifestEntriesTool = {
  name: 'qiln_read_manifest_entries',
  description:
    'Snapshot manifest-entry reads are temporarily unavailable. This compatibility tool accepts the existing snapshotId, rootId, optional afterLogicalPath, and limit selectors, then returns available: false, empty entries, and no next cursor. An empty response does not prove the snapshot or root exists or has no artifacts. This tool cannot traverse filesystems, read editable branches, or inspect live runtimes.',
  inputSchema: AgentSnapshotManifestEntriesInputSchema,
  outputSchema: AgentSnapshotManifestEntriesOutputSchema,
  async execute(
    client: QilnAgentClient,
    input: AgentSnapshotManifestEntries,
  ): Promise<AgentSnapshotManifestEntriesOutput> {
    return await client.manifestEntries(input)
  },
} as const satisfies QilnAgentTool<AgentSnapshotManifestEntries, AgentSnapshotManifestEntriesOutput>
