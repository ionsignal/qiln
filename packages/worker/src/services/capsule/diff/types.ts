export interface DiffInput {
  ownerId: string
  capsuleId: string
  branchId: string
  baselineSnapshotId: string | null
}

export const DiffUnavailableReason = {
  BASELINE_REQUIRED: 'baseline_required',
  PROVIDER_UNAVAILABLE: 'provider_native_diff_unavailable',
} as const

export type DiffUnavailableReason = (typeof DiffUnavailableReason)[keyof typeof DiffUnavailableReason]

/**
 * An unavailable result makes no assertion about the existence, ownership,
 * lineage, or contents of the supplied identities.
 *
 * Future available results require independent proof of committed snapshot
 * references, live branch resources, and exact ZFS dataset boundaries.
 */
export interface DiffUnavailable {
  status: 'unavailable'
  consistency: 'unavailable'
  baselineSnapshotId: string | null
  branchId: string
  reason: DiffUnavailableReason
  message: string
  volumes: readonly []
  incomplete: true
  truncated: false
}

export type DiffResult = DiffUnavailable
