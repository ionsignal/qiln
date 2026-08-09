import { z } from 'zod'

/**
 * Immutable policy selected when a Snapshot Capture operation is accepted.
 *
 * Snapshot reads never expose live runtime process state, injected environment
 * credentials, or secret stores. They read only bytes committed beneath managed
 * artifact roots. Developers are responsible for ensuring credentials are not
 * written into captured artifacts.
 *
 * When an owner selects `owner_authorized_unreviewed`, Qiln may return those
 * captured artifact bytes without secret scanning, classification, or
 * redaction.
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
