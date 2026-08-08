import {
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
  type AgentSnapshotManifestRoots,
  type AgentSnapshotManifestRootsOutput,
} from '@qiln/core/client'
import type { QilnAgentClient } from '../client'
import type { QilnAgentTool } from './tool'

/**
 * Reads one bounded page of immutable artifact-manifest roots from an exact
 * committed snapshot.
 */
export const qilnReadManifestRootsTool = {
  name: 'qiln_read_manifest_roots',
  description:
    'Read one bounded page of immutable artifact-manifest roots from an exact committed snapshot. Use this first to obtain rootId values for qiln_read_manifest_entries or qiln_read_artifact_content. Requires an exact snapshotId and cannot discover latest snapshots, enumerate snapshots, read editable branches, inspect live runtimes, or access Host files or provider storage.',
  inputSchema: AgentSnapshotManifestRootsInputSchema,
  outputSchema: AgentSnapshotManifestRootsOutputSchema,
  async execute(client: QilnAgentClient, input: AgentSnapshotManifestRoots): Promise<AgentSnapshotManifestRootsOutput> {
    return await client.manifestRoots(input)
  },
} as const satisfies QilnAgentTool<AgentSnapshotManifestRoots, AgentSnapshotManifestRootsOutput>
