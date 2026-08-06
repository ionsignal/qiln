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

export const AgentSnapshotArtifactContentSchema = z.string().superRefine((content, context) => {
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

export const AgentSnapshotReadMode = {
  MANIFEST: 'manifest',
  CONTENT: 'content',
} as const

export type AgentSnapshotReadMode = (typeof AgentSnapshotReadMode)[keyof typeof AgentSnapshotReadMode]

export const AgentSnapshotReadModeValues = [AgentSnapshotReadMode.MANIFEST, AgentSnapshotReadMode.CONTENT] as const

export const AgentSnapshotReadModeSchema = z.enum(AgentSnapshotReadModeValues)

const AgentSnapshotManifestLimitSchema = z
  .int()
  .min(1)
  .max(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS)
  .default(DEFAULT_AGENT_SNAPSHOT_MANIFEST_ITEMS)

/**
 * Lists bounded root metadata for one exact committed snapshot.
 *
 * Supplying no `rootId` intentionally selects only root metadata. A caller must
 * make a second, root-scoped manifest request before receiving artifact entry
 * metadata. This keeps pagination deterministic and bounded.
 */
export const AgentSnapshotManifestRootsReadSchema = z
  .object({
    mode: z.literal(AgentSnapshotReadMode.MANIFEST),
    snapshotId: z.uuid(),
    rootId: z.undefined().optional(),
    afterRootId: CapsuleArtifactRootIdSchema.optional(),
    limit: AgentSnapshotManifestLimitSchema,
  })
  .strict()

/**
 * Lists bounded entry metadata beneath one exact committed manifest root.
 *
 * `afterLogicalPath` is valid only inside the selected root and never acts as a
 * provider filesystem path or traversal instruction.
 */
export const AgentSnapshotManifestEntriesReadSchema = z
  .object({
    mode: z.literal(AgentSnapshotReadMode.MANIFEST),
    snapshotId: z.uuid(),
    rootId: CapsuleArtifactRootIdSchema,
    afterLogicalPath: AgentSnapshotArtifactLogicalPathSchema.optional(),
    limit: AgentSnapshotManifestLimitSchema,
  })
  .strict()

/**
 * Requests one exact regular-file artifact from immutable committed snapshot
 * evidence. The host and Worker must reject directory reads, traversal, live
 * branch reads, and uncommitted provider identities.
 */
export const AgentSnapshotContentReadSchema = z
  .object({
    mode: z.literal(AgentSnapshotReadMode.CONTENT),
    snapshotId: z.uuid(),
    rootId: CapsuleArtifactRootIdSchema,
    logicalPath: AgentSnapshotArtifactLogicalPathSchema,
  })
  .strict()

export const AgentSnapshotReadInputSchema = z.union([
  AgentSnapshotManifestRootsReadSchema,
  AgentSnapshotManifestEntriesReadSchema,
  AgentSnapshotContentReadSchema,
])

export const AgentSnapshotManifestRootsOutputSchema = z
  .object({
    mode: z.literal(AgentSnapshotReadMode.MANIFEST),
    view: z.literal('roots'),
    snapshotId: z.uuid(),
    roots: z.array(AgentSnapshotArtifactRootSchema).max(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS),
    nextAfterRootId: CapsuleArtifactRootIdSchema.nullable(),
  })
  .strict()

export const AgentSnapshotManifestEntriesOutputSchema = z
  .object({
    mode: z.literal(AgentSnapshotReadMode.MANIFEST),
    view: z.literal('entries'),
    snapshotId: z.uuid(),
    root: AgentSnapshotArtifactRootSchema,
    entries: z.array(AgentSnapshotArtifactEntrySchema).max(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS),
    nextAfterLogicalPath: AgentSnapshotArtifactLogicalPathSchema.nullable(),
  })
  .strict()

export const AgentSnapshotContentOutputSchema = z
  .object({
    mode: z.literal(AgentSnapshotReadMode.CONTENT),
    snapshotId: z.uuid(),
    rootId: CapsuleArtifactRootIdSchema,
    logicalPath: AgentSnapshotArtifactLogicalPathSchema,
    agentArtifactContentPolicy: z.literal(CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED),
    encoding: z.literal('utf-8'),
    size: z.int().nonnegative().max(MAX_AGENT_SNAPSHOT_ARTIFACT_CONTENT_BYTES),
    contentDigest: CapsuleArtifactContentDigestSchema,
    content: AgentSnapshotArtifactContentSchema,
  })
  .strict()

export const AgentSnapshotReadOutputSchema = z.union([
  AgentSnapshotManifestRootsOutputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotContentOutputSchema,
])

export type AgentSnapshotArtifactLogicalPath = z.infer<typeof AgentSnapshotArtifactLogicalPathSchema>
export type AgentSnapshotArtifactRoot = z.infer<typeof AgentSnapshotArtifactRootSchema>
export type AgentSnapshotArtifactEntry = z.infer<typeof AgentSnapshotArtifactEntrySchema>
export type AgentSnapshotArtifactContent = z.infer<typeof AgentSnapshotArtifactContentSchema>
export type AgentSnapshotReadInput = z.input<typeof AgentSnapshotReadInputSchema>
export type AgentSnapshotRead = z.output<typeof AgentSnapshotReadInputSchema>
export type AgentSnapshotManifestRootsRead = z.output<typeof AgentSnapshotManifestRootsReadSchema>
export type AgentSnapshotManifestEntriesRead = z.output<typeof AgentSnapshotManifestEntriesReadSchema>
export type AgentSnapshotContentRead = z.output<typeof AgentSnapshotContentReadSchema>
export type AgentSnapshotReadOutput = z.infer<typeof AgentSnapshotReadOutputSchema>
export type AgentSnapshotManifestRootsOutput = z.infer<typeof AgentSnapshotManifestRootsOutputSchema>
export type AgentSnapshotManifestEntriesOutput = z.infer<typeof AgentSnapshotManifestEntriesOutputSchema>
export type AgentSnapshotContentOutput = z.infer<typeof AgentSnapshotContentOutputSchema>
