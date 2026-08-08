import { z } from 'zod'
import {
  AgentActorSchema,
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
} from '../../../schemas/agent'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from './definitions'

const CAPSULE_AGENT_SNAPSHOT_READ_TIMEOUT_MS = 30_000

/**
 * The host publishes these commands only after API-key authentication derives
 * the requester, agent actor, capsule scope, and exact snapshot selectors. The
 * Worker must still prove committed snapshot lineage before returning metadata
 * or artifact content.
 */
export const CapsuleAgentReadCommandName = {
  MANIFEST_ROOTS: 'capsule.agent.read.manifestRoots',
  MANIFEST_ENTRIES: 'capsule.agent.read.manifestEntries',
  ARTIFACT_CONTENT: 'capsule.agent.read.artifactContent',
} as const

export type CapsuleAgentReadCommandName = (typeof CapsuleAgentReadCommandName)[keyof typeof CapsuleAgentReadCommandName]

export const CapsuleAgentReadCommandNameValues = [
  CapsuleAgentReadCommandName.MANIFEST_ROOTS,
  CapsuleAgentReadCommandName.MANIFEST_ENTRIES,
  CapsuleAgentReadCommandName.ARTIFACT_CONTENT,
] as const

const CapsuleAgentReadBaseSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: AgentActorSchema,
    capsuleId: z.uuid(),
  })
  .strict()

export const CapsuleAgentManifestRootsInputSchema = CapsuleAgentReadBaseSchema.extend(
  AgentSnapshotManifestRootsInputSchema.shape,
).strict()

export const CapsuleAgentManifestEntriesInputSchema = CapsuleAgentReadBaseSchema.extend(
  AgentSnapshotManifestEntriesInputSchema.shape,
).strict()

export const CapsuleAgentArtifactContentInputSchema = CapsuleAgentReadBaseSchema.extend(
  AgentSnapshotArtifactContentRequestSchema.shape,
).strict()

export const CapsuleAgentManifestRootsOutputSchema = AgentSnapshotManifestRootsOutputSchema
export const CapsuleAgentManifestEntriesOutputSchema = AgentSnapshotManifestEntriesOutputSchema
export const CapsuleAgentArtifactContentOutputSchema = AgentSnapshotArtifactContentOutputSchema

export type CapsuleAgentManifestRootsInput = input<typeof CapsuleAgentManifestRootsInputSchema>
export type CapsuleAgentManifestRoots = output<typeof CapsuleAgentManifestRootsInputSchema>
export type CapsuleAgentManifestRootsOutput = output<typeof CapsuleAgentManifestRootsOutputSchema>

export type CapsuleAgentManifestEntriesInput = input<typeof CapsuleAgentManifestEntriesInputSchema>
export type CapsuleAgentManifestEntries = output<typeof CapsuleAgentManifestEntriesInputSchema>
export type CapsuleAgentManifestEntriesOutput = output<typeof CapsuleAgentManifestEntriesOutputSchema>

export type CapsuleAgentArtifactContentInput = input<typeof CapsuleAgentArtifactContentInputSchema>
export type CapsuleAgentArtifactContent = output<typeof CapsuleAgentArtifactContentInputSchema>
export type CapsuleAgentArtifactContentOutput = output<typeof CapsuleAgentArtifactContentOutputSchema>

export const CapsuleAgentReadCommandDefinitions = {
  [CapsuleAgentReadCommandName.MANIFEST_ROOTS]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleAgentReadCommandName.MANIFEST_ROOTS,
    inputSchema: CapsuleAgentManifestRootsInputSchema,
    outputSchema: CapsuleAgentManifestRootsOutputSchema,
    timeoutMs: CAPSULE_AGENT_SNAPSHOT_READ_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleAgentManifestRoots) {
        return payload.target
      },
    },
  }),
  [CapsuleAgentReadCommandName.MANIFEST_ENTRIES]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleAgentReadCommandName.MANIFEST_ENTRIES,
    inputSchema: CapsuleAgentManifestEntriesInputSchema,
    outputSchema: CapsuleAgentManifestEntriesOutputSchema,
    timeoutMs: CAPSULE_AGENT_SNAPSHOT_READ_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleAgentManifestEntries) {
        return payload.target
      },
    },
  }),
  [CapsuleAgentReadCommandName.ARTIFACT_CONTENT]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleAgentReadCommandName.ARTIFACT_CONTENT,
    inputSchema: CapsuleAgentArtifactContentInputSchema,
    outputSchema: CapsuleAgentArtifactContentOutputSchema,
    timeoutMs: CAPSULE_AGENT_SNAPSHOT_READ_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleAgentArtifactContent) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleAgentReadCommandName, CapsuleCommandDefinition>
