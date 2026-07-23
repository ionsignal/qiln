import {
  CapsuleSnapshotLimitation,
  type CapsuleSnapshotCapturePolicyPin,
  type CapsuleSnapshotGitRepository,
  type CapsuleSnapshotLimitationValue,
} from '@qiln/core/server'

export interface CaptureGitInput {
  operationId: string
  policy: CapsuleSnapshotCapturePolicyPin
}

export interface CaptureGitResult {
  repositories: readonly CapsuleSnapshotGitRepository[]
  limitations: readonly CapsuleSnapshotLimitationValue[]
}

/**
 * Typed boundary for future declared-repository inspection.
 *
 * The initial experimental capture excludes `.git` administrative content from
 * the canonical artifact manifest and commits no Git repository evidence.
 *
 * TODO(snapshot-capture): Inspect each repository declared by the historical
 * policy from immutable snapshot-backed storage. Reject unsupported worktrees,
 * submodules, bare repositories, undeclared nested repositories, and unsafe
 * remote metadata before removing this limitation.
 */
export class CaptureGitCollector {
  public async collect(_input: CaptureGitInput): Promise<CaptureGitResult> {
    return {
      repositories: [],
      limitations: [CapsuleSnapshotLimitation.GIT_EVIDENCE_OMITTED],
    }
  }
}
