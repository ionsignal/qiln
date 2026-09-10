export const SnapshotStep = {
  REVOKE_SSH: 'revoke_snapshot_ssh_access',
  VERIFY: 'verify_snapshot_source',
  CREATE: 'create_volume_snapshots',
  COMMIT: 'commit_snapshot',
} as const

export type SnapshotStep = (typeof SnapshotStep)[keyof typeof SnapshotStep]

/**
 * Inspection boundaries only. These steps never authorize replay or resumption
 * of an interrupted provider mutation.
 */
export const SnapshotSteps = [
  SnapshotStep.REVOKE_SSH,
  SnapshotStep.VERIFY,
  SnapshotStep.CREATE,
  SnapshotStep.COMMIT,
] as const satisfies readonly SnapshotStep[]
