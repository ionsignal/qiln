import type { CapsuleSnapshotResourceReference, CapsuleTables } from '@qiln/core/server'

/**
 * Committed restoration evidence read by snapshot history and fork consumers.
 *
 * Provider references remain server-side. They do not describe file contents,
 * Git state, external bind contents, or application correctness.
 */
export type CapsuleSnapshotRecord = CapsuleTables['capsuleSnapshots']['$inferSelect'] & {
  resources: CapsuleSnapshotResourceReference[]
}
