import {
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
  type AgentSnapshotArtifactContentRequest,
  type AgentSnapshotArtifactContentOutput,
  type AgentSnapshotManifestEntries,
  type AgentSnapshotManifestEntriesOutput,
  type AgentSnapshotManifestRoots,
  type AgentSnapshotManifestRootsOutput,
  type CapsuleChannel,
} from '@qiln/core/server'
import { resolveAgentAuthority } from '@server/agent/authority'
import type { Database } from '@server/db'

export class AgentSnapshotNotFoundError extends Error {
  constructor() {
    super('Snapshot not found.')
    this.name = 'AgentSnapshotNotFoundError'
  }
}

export class AgentArtifactContentDeniedError extends Error {
  constructor() {
    super('Artifact content is not available for this snapshot.')
    this.name = 'AgentArtifactContentDeniedError'
  }
}

/**
 * Retains credential and capsule-scope checks without querying snapshot
 * history.
 *
 * Successful authorization permits only an unavailable response. It does not
 * prove that a requested snapshot exists or belongs to the credential's scope.
 */
async function authorize(db: Database, apiKey: string | null): Promise<void> {
  const authority = await resolveAgentAuthority(db, apiKey)
  if (authority.capsule === null) {
    throw new AgentSnapshotNotFoundError()
  }
}

/**
 * Preserves the manifest-root endpoint with an explicit unavailable empty page.
 *
 * The channel parameter remains for Host integration compatibility. No Worker
 * command, manifest query, or provider read is performed.
 */
export async function resolveAgentManifestRoots(
  db: Database,
  _channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentSnapshotManifestRoots,
): Promise<AgentSnapshotManifestRootsOutput> {
  await authorize(db, apiKey)

  return AgentSnapshotManifestRootsOutputSchema.parse({
    snapshotId: input.snapshotId,
    available: false,
    reason: 'snapshot_reads_unavailable',
    roots: [],
    nextCursor: null,
  })
}

/**
 * Preserves the manifest-entry endpoint with an explicit unavailable empty
 * page.
 *
 * Echoed selectors identify only the request; they do not attest to a real
 * snapshot or manifest root.
 */
export async function resolveAgentManifestEntries(
  db: Database,
  _channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentSnapshotManifestEntries,
): Promise<AgentSnapshotManifestEntriesOutput> {
  await authorize(db, apiKey)

  return AgentSnapshotManifestEntriesOutputSchema.parse({
    snapshotId: input.snapshotId,
    rootId: input.rootId,
    available: false,
    reason: 'snapshot_reads_unavailable',
    entries: [],
    nextCursor: null,
  })
}

/**
 * Preserves the artifact-content endpoint without reading any artifact bytes.
 *
 * Null content distinguishes unavailable access from a real empty file. No
 * legacy content policy, filesystem path, or provider reference is resolved.
 */
export async function resolveAgentArtifactContent(
  db: Database,
  _channel: CapsuleChannel,
  apiKey: string | null,
  input: AgentSnapshotArtifactContentRequest,
): Promise<AgentSnapshotArtifactContentOutput> {
  await authorize(db, apiKey)

  return AgentSnapshotArtifactContentOutputSchema.parse({
    snapshotId: input.snapshotId,
    rootId: input.rootId,
    logicalPath: input.logicalPath,
    available: false,
    reason: 'snapshot_reads_unavailable',
    content: null,
  })
}

export {
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
}
