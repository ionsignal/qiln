import { z } from 'zod'

/**
 * Operation-scoped state for one planned physical provider snapshot.
 *
 * These states describe privileged Snapshot Capture execution accounting. They
 * are not committed snapshot history and must never become branch-fork
 * authority.
 *
 * `missing` is a cleanup outcome proving that a previously recorded provider
 * snapshot no longer exists. An ambiguous provider result must use `error`
 * rather than being inferred as missing.
 */
export const CapsuleSnapshotCaptureResourceStatus = {
  PLANNED: 'planned',
  CREATING: 'creating',
  CREATED: 'created',
  DELETING: 'deleting',
  DELETED: 'deleted',
  MISSING: 'missing',
  ERROR: 'error',
} as const

export type CapsuleSnapshotCaptureResourceStatusValue =
  (typeof CapsuleSnapshotCaptureResourceStatus)[keyof typeof CapsuleSnapshotCaptureResourceStatus]

export const CapsuleSnapshotCaptureResourceStatusValues = [
  CapsuleSnapshotCaptureResourceStatus.PLANNED,
  CapsuleSnapshotCaptureResourceStatus.CREATING,
  CapsuleSnapshotCaptureResourceStatus.CREATED,
  CapsuleSnapshotCaptureResourceStatus.DELETING,
  CapsuleSnapshotCaptureResourceStatus.DELETED,
  CapsuleSnapshotCaptureResourceStatus.MISSING,
  CapsuleSnapshotCaptureResourceStatus.ERROR,
] as const

export const CapsuleSnapshotCaptureResourceStatusSchema = z.enum(CapsuleSnapshotCaptureResourceStatusValues)
