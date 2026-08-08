import {
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  type AgentSnapshotManifestEntries,
  type AgentSnapshotManifestEntriesOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Reads one bounded page of immutable manifest entries beneath one exact root
 * in one exact committed snapshot.
 */
export const qilnReadManifestEntriesTool = {
  name: 'qiln_read_manifest_entries',
  description:
    'Read one bounded page of immutable artifact-manifest entries beneath one selected root in an exact committed snapshot. Obtain rootId from qiln_read_manifest_roots, then use returned logicalPath values as exact selectors for qiln_read_artifact_content where policy permits. This tool cannot discover snapshots, traverse arbitrary filesystems, read editable branches, or inspect live runtimes.',
  inputSchema: AgentSnapshotManifestEntriesInputSchema,
  outputSchema: AgentSnapshotManifestEntriesOutputSchema,
  async execute(
    client: QilnAgentClient,
    input: AgentSnapshotManifestEntries,
  ): Promise<AgentSnapshotManifestEntriesOutput> {
    return await client.manifestEntries(input)
  },
} as const satisfies QilnAgentTool<AgentSnapshotManifestEntries, AgentSnapshotManifestEntriesOutput>
