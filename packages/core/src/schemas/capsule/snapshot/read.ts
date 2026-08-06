import { z } from 'zod'

/**
 * Immutable policy selected when a Snapshot Capture operation is accepted.
 */
export const CapsuleSnapshotAgentArtifactContentPolicy = {
  DENY: 'deny',
  OWNER_AUTHORIZED_UNREVIEWED: 'owner_authorized_unreviewed',
} as const

export type CapsuleSnapshotAgentArtifactContentPolicyValue =
  (typeof CapsuleSnapshotAgentArtifactContentPolicy)[keyof typeof CapsuleSnapshotAgentArtifactContentPolicy]

export const CapsuleSnapshotAgentArtifactContentPolicyValues = [
  CapsuleSnapshotAgentArtifactContentPolicy.DENY,
  CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED,
] as const

export const CapsuleSnapshotAgentArtifactContentPolicySchema = z.enum(CapsuleSnapshotAgentArtifactContentPolicyValues)
