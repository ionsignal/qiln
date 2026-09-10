import { z } from 'zod'
import { CapsuleActorReferenceSchema, CapsuleActorType } from './capsule/actor'
import { CapsuleBranchNameSchema, CapsuleBranchStatusSchema } from './capsule/branch'
import { CapsuleLifecycleStateSchema } from './capsule/lifecycle'
import { isCanonicalRelativePosixPath } from './posix'

export const MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS = 100
export const MAX_AGENT_SNAPSHOT_READ_REQUEST_BYTES = 16 * 1024

export const AgentActorSchema = CapsuleActorReferenceSchema.extend({
  type: z.literal(CapsuleActorType.AGENT),
}).strict()

export const AgentRequesterSchema = z
  .object({
    id: z.uuid(),
    username: z.string().min(1),
  })
  .strict()

export const AgentBranchContextSchema = z
  .object({
    id: z.uuid(),
    name: CapsuleBranchNameSchema,
    isRootBranch: z.boolean(),
    status: CapsuleBranchStatusSchema,
  })
  .strict()

export const AgentGetContextInputSchema = z
  .object({
    branchId: z.uuid().optional(),
    branchName: CapsuleBranchNameSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.branchId !== undefined && input.branchName !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['branchName'],
        message: 'Specify at most one branch selector.',
      })
    }
  })

/**
 * Temporary agent context compatibility boundary.
 *
 * Identity and optional capsule and branch scope remain Host-derived. Snapshot
 * selection is unavailable rather than inferred from restoration history that
 * no longer provides the former artifact-read contract.
 */
export const AgentGetContextOutputSchema = z
  .object({
    requester: AgentRequesterSchema,
    agent: AgentActorSchema,
    capsule: CapsuleLifecycleStateSchema.nullable(),
    branch: AgentBranchContextSchema.nullable(),
    snapshot: z.null(),
  })
  .strict()

const RootIdSchema = z.string().min(1).max(128)

const LogicalPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => isCanonicalRelativePosixPath(value, true), {
    message: 'Artifact logical paths must be canonical relative POSIX paths.',
  })

const ManifestLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS)
  .default(MAX_AGENT_SNAPSHOT_MANIFEST_ITEMS)

/**
 * Retained request contracts validate bounded selectors without granting
 * filesystem access or asserting that the selected snapshot exists.
 */
export const AgentSnapshotManifestRootsInputSchema = z
  .object({
    snapshotId: z.uuid(),
    afterRootId: RootIdSchema.optional(),
    limit: ManifestLimitSchema,
  })
  .strict()

export const AgentSnapshotManifestEntriesInputSchema = z
  .object({
    snapshotId: z.uuid(),
    rootId: RootIdSchema,
    afterLogicalPath: LogicalPathSchema.optional(),
    limit: ManifestLimitSchema,
  })
  .strict()

export const AgentSnapshotArtifactContentRequestSchema = z
  .object({
    snapshotId: z.uuid(),
    rootId: RootIdSchema,
    logicalPath: LogicalPathSchema,
  })
  .strict()

/**
 * Stub responses explicitly distinguish unavailable reads from real empty
 * manifests or files. Echoed selectors are request identifiers, not evidence of
 * snapshot existence, ownership, or committed artifact content.
 */
const SnapshotReadUnavailableSchema = z
  .object({
    snapshotId: z.uuid(),
    available: z.literal(false),
    reason: z.literal('snapshot_reads_unavailable'),
  })
  .strict()

export const AgentSnapshotManifestRootsOutputSchema = SnapshotReadUnavailableSchema.extend({
  roots: z.array(z.never()).length(0),
  nextCursor: z.null(),
}).strict()

export const AgentSnapshotManifestEntriesOutputSchema = SnapshotReadUnavailableSchema.extend({
  rootId: RootIdSchema,
  entries: z.array(z.never()).length(0),
  nextCursor: z.null(),
}).strict()

export const AgentSnapshotArtifactContentOutputSchema = SnapshotReadUnavailableSchema.extend({
  rootId: RootIdSchema,
  logicalPath: LogicalPathSchema,
  content: z.null(),
}).strict()

export type AgentActor = z.infer<typeof AgentActorSchema>
export type AgentRequester = z.infer<typeof AgentRequesterSchema>
export type AgentBranchContext = z.infer<typeof AgentBranchContextSchema>
export type AgentGetContextInput = z.input<typeof AgentGetContextInputSchema>
export type AgentGetContext = z.output<typeof AgentGetContextInputSchema>
export type AgentGetContextOutput = z.output<typeof AgentGetContextOutputSchema>
export type AgentSnapshotManifestRootsInput = z.input<typeof AgentSnapshotManifestRootsInputSchema>
export type AgentSnapshotManifestRoots = z.output<typeof AgentSnapshotManifestRootsInputSchema>
export type AgentSnapshotManifestRootsOutput = z.output<typeof AgentSnapshotManifestRootsOutputSchema>
export type AgentSnapshotManifestEntriesInput = z.input<typeof AgentSnapshotManifestEntriesInputSchema>
export type AgentSnapshotManifestEntries = z.output<typeof AgentSnapshotManifestEntriesInputSchema>
export type AgentSnapshotManifestEntriesOutput = z.output<typeof AgentSnapshotManifestEntriesOutputSchema>
export type AgentSnapshotArtifactContentRequest = z.infer<typeof AgentSnapshotArtifactContentRequestSchema>
export type AgentSnapshotArtifactContentOutput = z.output<typeof AgentSnapshotArtifactContentOutputSchema>
