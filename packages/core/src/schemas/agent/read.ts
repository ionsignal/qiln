import { z } from 'zod'
import {
  CapsuleArtifactContentDigestSchema,
  CapsuleArtifactEntrySchema,
  CapsuleArtifactLogicalPathSchema,
  CapsuleArtifactManifestRootSchema,
  CapsuleArtifactRootIdSchema,
} from '../capsule/artifact'
import { CapsuleSnapshotAgentArtifactContentPolicy } from '../capsule/snapshot/read'

export const MAX_AGENT_SNAPSHOT_READ_REQUEST_BYTES = 16 * 1024
export const MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS = 100
export const DEFAULT_AGENT_SNAPSHOT_MANIFEST_ITEMS = 50
export const MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES = 64 * 1024
export const MAX_AGENT_SNAPSHOT_LOGICAL_PATH_LENGTH = 4096

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Agent responses must remain bounded even when a malformed or unexpectedly
 * large committed manifest exists. The Worker must reject overlong committed
 * paths instead of returning an oversized metadata response.
 */
export const AgentSnapshotArtifactLogicalPathSchema = CapsuleArtifactLogicalPathSchema.superRefine(
  (logicalPath, context) => {
    if (logicalPath.length <= MAX_AGENT_SNAPSHOT_LOGICAL_PATH_LENGTH) {
      return
    }
    context.addIssue({
      code: 'too_big',
      maximum: MAX_AGENT_SNAPSHOT_LOGICAL_PATH_LENGTH,
      inclusive: true,
      origin: 'string',
      message: `Agent-readable artifact paths cannot exceed ${MAX_AGENT_SNAPSHOT_LOGICAL_PATH_LENGTH} characters.`,
    })
  },
)

export const AgentSnapshotArtifactRootSchema = CapsuleArtifactManifestRootSchema.extend({
  logicalPath: AgentSnapshotArtifactLogicalPathSchema,
}).strict()

export const AgentSnapshotArtifactEntrySchema = CapsuleArtifactEntrySchema.superRefine((entry, context) => {
  if (entry.logicalPath.length <= MAX_AGENT_SNAPSHOT_LOGICAL_PATH_LENGTH) {
    return
  }
  context.addIssue({
    code: 'too_big',
    path: ['logicalPath'],
    maximum: MAX_AGENT_SNAPSHOT_LOGICAL_PATH_LENGTH,
    inclusive: true,
    origin: 'string',
    message: `Agent-readable artifact paths cannot exceed ${MAX_AGENT_SNAPSHOT_LOGICAL_PATH_LENGTH} characters.`,
  })
})

/**
 * Bounded UTF-8 text returned for one owner-authorized artifact-content read.
 *
 * This is the returned payload, not the request selector used to ask for an
 * artifact. Keeping those names separate prevents input/output contract
 * collisions across Host, Worker, Agent, and MCP boundaries.
 */
export const AgentSnapshotArtifactTextSchema = z
  .string()
  .superRefine((content, context) => {
    const size = utf8ByteLength(content)
    if (size <= MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES) {
      return
    }
    context.addIssue({
      code: 'too_big',
      maximum: MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES,
      inclusive: true,
      origin: 'string',
      message: `Agent-readable artifact content cannot exceed ${MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES} UTF-8 bytes.`,
    })
  })
  .describe('UTF-8 artifact content verified against immutable committed manifest evidence.')

const AgentSnapshotIdSchema = z.uuid().describe('Exact committed snapshot ID. Qiln cannot discover a latest snapshot.')

const AgentSnapshotRootIdSchema = CapsuleArtifactRootIdSchema.describe(
  'Exact artifact root ID returned by qiln_read_manifest_roots.',
)

const AgentSnapshotPathSelectorSchema = AgentSnapshotArtifactLogicalPathSchema.describe(
  'Exact logical path returned by qiln_read_manifest_entries. This is not a host or provider filesystem path.',
)

const AgentSnapshotManifestLimitSchema = z
  .int()
  .min(1)
  .max(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS)
  .default(DEFAULT_AGENT_SNAPSHOT_MANIFEST_ITEMS)
  .describe(`Maximum number of manifest items to return, from 1 to ${MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS}.`)

/**
 * Lists bounded root metadata for one exact committed snapshot.
 */
export const AgentSnapshotManifestRootsInputSchema = z
  .object({
    snapshotId: AgentSnapshotIdSchema,
    afterRootId: AgentSnapshotRootIdSchema.optional().describe(
      'Return roots strictly after this root ID. Omit for the first page.',
    ),
    limit: AgentSnapshotManifestLimitSchema,
  })
  .strict()
  .describe('Read one bounded page of immutable artifact manifest roots from an exact committed snapshot.')
  .meta({
    examples: [
      {
        snapshotId: '018f7d8c-7f2a-7b8c-8f0e-1e2d3c4b5a6f',
        limit: 50,
      },
    ],
  })

/**
 * Lists bounded entry metadata beneath one exact committed manifest root.
 *
 * `afterLogicalPath` is valid only inside the selected root and never acts as a
 * provider filesystem path or traversal instruction.
 */
export const AgentSnapshotManifestEntriesInputSchema = z
  .object({
    snapshotId: AgentSnapshotIdSchema,
    rootId: AgentSnapshotRootIdSchema,
    afterLogicalPath: AgentSnapshotPathSelectorSchema.optional().describe(
      'Return entries strictly after this logical path within the selected root. Omit for the first page.',
    ),
    limit: AgentSnapshotManifestLimitSchema,
  })
  .strict()
  .describe('Read one bounded page of immutable artifact manifest entries beneath one selected root.')
  .meta({
    examples: [
      {
        snapshotId: '018f7d8c-7f2a-7b8c-8f0e-1e2d3c4b5a6f',
        rootId: 'workflow-data',
        limit: 50,
      },
    ],
  })

/**
 * Requests one exact regular-file artifact from immutable committed snapshot
 * evidence. The host and Worker must reject directory reads, traversal, live
 * branch reads, and uncommitted provider identities.
 */
export const AgentSnapshotArtifactContentRequestSchema = z
  .object({
    snapshotId: AgentSnapshotIdSchema,
    rootId: AgentSnapshotRootIdSchema,
    logicalPath: AgentSnapshotPathSelectorSchema,
  })
  .strict()
  .describe(
    'Read one bounded UTF-8 regular file from immutable committed snapshot evidence when the snapshot explicitly permits artifact content access.',
  )
  .meta({
    examples: [
      {
        snapshotId: '018f7d8c-7f2a-7b8c-8f0e-1e2d3c4b5a6f',
        rootId: 'workflow-data',
        logicalPath: '/data/workflows/main.json',
      },
    ],
  })

export const AgentSnapshotManifestRootsOutputSchema = z
  .object({
    snapshotId: z.uuid(),
    roots: z.array(AgentSnapshotArtifactRootSchema).max(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS),
    nextAfterRootId: CapsuleArtifactRootIdSchema.nullable(),
  })
  .strict()

export const AgentSnapshotManifestEntriesOutputSchema = z
  .object({
    snapshotId: z.uuid(),
    root: AgentSnapshotArtifactRootSchema,
    entries: z.array(AgentSnapshotArtifactEntrySchema).max(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS),
    nextAfterLogicalPath: AgentSnapshotArtifactLogicalPathSchema.nullable(),
  })
  .strict()

export const AgentSnapshotArtifactContentOutputSchema = z
  .object({
    snapshotId: z.uuid(),
    rootId: CapsuleArtifactRootIdSchema,
    logicalPath: AgentSnapshotArtifactLogicalPathSchema,
    agentArtifactContentPolicy: z.literal(CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED),
    encoding: z.literal('utf-8'),
    size: z.int().nonnegative().max(MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES),
    contentDigest: CapsuleArtifactContentDigestSchema,
    content: AgentSnapshotArtifactTextSchema,
  })
  .strict()

export type AgentSnapshotArtifactLogicalPath = z.infer<typeof AgentSnapshotArtifactLogicalPathSchema>
export type AgentSnapshotArtifactRoot = z.infer<typeof AgentSnapshotArtifactRootSchema>
export type AgentSnapshotArtifactEntry = z.infer<typeof AgentSnapshotArtifactEntrySchema>
export type AgentSnapshotArtifactText = z.infer<typeof AgentSnapshotArtifactTextSchema>

export type AgentSnapshotManifestRootsInput = z.input<typeof AgentSnapshotManifestRootsInputSchema>
export type AgentSnapshotManifestRoots = z.output<typeof AgentSnapshotManifestRootsInputSchema>

export type AgentSnapshotManifestEntriesInput = z.input<typeof AgentSnapshotManifestEntriesInputSchema>
export type AgentSnapshotManifestEntries = z.output<typeof AgentSnapshotManifestEntriesInputSchema>

export type AgentSnapshotArtifactContentRequestInput = z.input<typeof AgentSnapshotArtifactContentRequestSchema>
export type AgentSnapshotArtifactContentRequest = z.output<typeof AgentSnapshotArtifactContentRequestSchema>

export type AgentSnapshotManifestRootsOutput = z.infer<typeof AgentSnapshotManifestRootsOutputSchema>
export type AgentSnapshotManifestEntriesOutput = z.infer<typeof AgentSnapshotManifestEntriesOutputSchema>
export type AgentSnapshotArtifactContentOutput = z.infer<typeof AgentSnapshotArtifactContentOutputSchema>
