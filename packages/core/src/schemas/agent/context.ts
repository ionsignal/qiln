import { z } from 'zod'
import { CapsuleArtifactManifestReferenceSchema } from '../capsule/artifact/reference'
import { CapsuleActorType } from '../capsule/actor'
import { CapsuleBranchNameSchema, CapsuleBranchStatusSchema } from '../capsule/branch'
import { CapsuleLifecycleStateSchema } from '../capsule/lifecycle'
import { CapsuleSnapshotTimestampSchema } from '../capsule/snapshot/record'
import { CapsuleSnapshotAgentArtifactContentPolicySchema } from '../capsule/snapshot/read'

export const AgentBranchSelectorSchema = z
  .object({
    branchId: z.uuid().optional().describe('Optional exact editable branch ID to inspect.'),
    branchName: CapsuleBranchNameSchema.optional().describe('Optional editable branch name to inspect.'),
  })
  .strict()
  .superRefine((selector, context) => {
    if (selector.branchId !== undefined && selector.branchName !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Specify either branchId or branchName, not both.',
      })
    }
  })

/**
 * The external agent may supply only a branch selector. The host derives every
 * identity, capsule scope, and snapshot selection decision from its API
 * credential and committed capsule evidence.
 */
export const AgentGetContextInputSchema = AgentBranchSelectorSchema

export const AgentRequesterSchema = z
  .object({
    id: z.uuid(),
    username: z.string().min(1),
  })
  .strict()

export const AgentActorSchema = z
  .object({
    type: z.literal(CapsuleActorType.AGENT),
    id: z.uuid(),
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

export const AgentSnapshotSelection = {
  CAPSULE_LATEST: 'capsule_latest',
  BRANCH_LATEST: 'branch_latest',
  FORK_BASE: 'fork_base',
} as const

export const AgentSnapshotSelectionValues = [
  AgentSnapshotSelection.CAPSULE_LATEST,
  AgentSnapshotSelection.BRANCH_LATEST,
  AgentSnapshotSelection.FORK_BASE,
] as const

export const AgentSnapshotSelectionSchema = z
  .enum(AgentSnapshotSelectionValues)
  .describe(
    'Why Qiln selected this snapshot: capsule_latest is the newest readable capsule snapshot, branch_latest is the newest readable capture from the selected branch, and fork_base is the readable snapshot used to fork the selected branch.',
  )

/**
 * Exact immutable committed snapshot context selected by the Worker.
 *
 * This reference is not a mutable latest pointer and does not reserve the
 * snapshot. Later manifest and artifact reads must use its exact ID, and may
 * reject it if the snapshot is archived after this context response.
 */
export const AgentContextSnapshotSchema = z
  .object({
    id: z.uuid().describe('Exact immutable committed snapshot ID for later explicit snapshot reads.'),
    sourceBranchId: z.uuid().describe('Exact branch ID from which this snapshot was captured.'),
    sourceBranchName: CapsuleBranchNameSchema.describe('Branch name recorded when this snapshot was captured.'),
    createdAt: CapsuleSnapshotTimestampSchema.describe('Timestamp when this immutable committed snapshot was created.'),
    selection: AgentSnapshotSelectionSchema,
    artifactManifest: CapsuleArtifactManifestReferenceSchema.describe(
      'Verified immutable artifact-manifest reference for the selected snapshot.',
    ),
    agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicySchema.describe(
      'Whether later exact artifact-content reads are denied or owner-authorized without secret review.',
    ),
  })
  .strict()
  .describe(
    'One exact readable committed snapshot selected for later explicit manifest and artifact reads. The snapshot is immutable but is not reserved against later archival.',
  )

/**
 * Authoritative external-agent context returned by the host control plane.
 *
 * A selected branch is never authority by itself. The host proves that it
 * belongs to the API credential's capsule scope before returning it here.
 */
export const AgentGetContextOutputSchema = z
  .object({
    requester: AgentRequesterSchema,
    agent: AgentActorSchema,
    capsule: CapsuleLifecycleStateSchema.nullable().describe(
      'Capsule lifecycle state derived from the API credential scope, or null for an unscoped credential.',
    ),
    branch: AgentBranchContextSchema.nullable().describe(
      'Selected branch proven to belong to the scoped capsule, or null when no branch was selected.',
    ),
    snapshot: AgentContextSnapshotSchema.nullable().describe(
      'Exact immutable readable snapshot selected from committed capsule history, or null when none is eligible.',
    ),
  })
  .strict()
  .describe(
    'Host-derived agent authority and inspection context. Snapshot IDs are immutable references, not mutable latest pointers.',
  )
  .superRefine((value, issue) => {
    if (value.capsule === null && value.branch !== null) {
      issue.addIssue({
        code: 'custom',
        path: ['branch'],
        message: 'An unscoped agent credential cannot resolve a branch.',
      })
    }
    if (value.capsule === null && value.snapshot !== null) {
      issue.addIssue({
        code: 'custom',
        path: ['snapshot'],
        message: 'An unscoped agent credential cannot resolve a snapshot.',
      })
    }
  })

export type AgentBranchSelector = z.infer<typeof AgentBranchSelectorSchema>
export type AgentGetContextInput = z.input<typeof AgentGetContextInputSchema>
export type AgentGetContext = z.output<typeof AgentGetContextInputSchema>
export type AgentRequester = z.infer<typeof AgentRequesterSchema>
export type AgentActor = z.infer<typeof AgentActorSchema>
export type AgentBranchContext = z.infer<typeof AgentBranchContextSchema>
export type AgentSnapshotSelection = z.infer<typeof AgentSnapshotSelectionSchema>
export type AgentContextSnapshot = z.infer<typeof AgentContextSnapshotSchema>
export type AgentGetContextOutput = z.infer<typeof AgentGetContextOutputSchema>
