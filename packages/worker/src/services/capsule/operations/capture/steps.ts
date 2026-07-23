export const CaptureStepKey = {
  PLAN: 'plan_capture',
  SNAPSHOT: 'create_provider_snapshots',
  COLLECT: 'collect_artifacts',
  GIT: 'collect_git',
  COMMIT: 'commit_snapshot',
} as const

export type CaptureStepKey = (typeof CaptureStepKey)[keyof typeof CaptureStepKey]

/**
 * Durable inspection boundaries for experimental Snapshot Capture.
 *
 * These rows are not resumable checkpoints. An abandoned capture is classified
 * from PostgreSQL evidence and must never continue from one of these steps.
 */
export const CaptureStepKeys = [
  CaptureStepKey.PLAN,
  CaptureStepKey.SNAPSHOT,
  CaptureStepKey.COLLECT,
  CaptureStepKey.GIT,
  CaptureStepKey.COMMIT,
] as const satisfies readonly CaptureStepKey[]
