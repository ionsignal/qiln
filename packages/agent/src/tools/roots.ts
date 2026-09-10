import {
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
  type AgentSnapshotManifestRoots,
  type AgentSnapshotManifestRootsOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Retains the manifest-root capability as an explicit unavailable response
 * while agent snapshot reads are disabled.
 */
export const qilnReadManifestRootsTool = {
  name: 'qiln_read_manifest_roots',
  description:
    'Snapshot manifest-root reads are temporarily unavailable. This compatibility tool accepts the existing snapshotId, optional afterRootId, and limit selectors, then returns available: false, empty roots, and no next cursor. An empty response does not prove the snapshot exists or has no artifacts. This tool cannot discover snapshots, read editable branches, inspect live runtimes, or access Host files or provider storage.',
  inputSchema: AgentSnapshotManifestRootsInputSchema,
  outputSchema: AgentSnapshotManifestRootsOutputSchema,
  async execute(client: QilnAgentClient, input: AgentSnapshotManifestRoots): Promise<AgentSnapshotManifestRootsOutput> {
    return await client.manifestRoots(input)
  },
} as const satisfies QilnAgentTool<AgentSnapshotManifestRoots, AgentSnapshotManifestRootsOutput>
