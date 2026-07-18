import type { CapsuleHostDbContract } from '@qiln/core/server'
import { CapsuleSnapshotService } from '../snapshot/service'
import { CapsuleSnapshotStore } from '../snapshot/store'

export interface ComposeSnapshotCapabilityOptions {
  db: CapsuleHostDbContract
}

/**
 * Composes read-only committed capsule snapshot history.
 *
 * Snapshot capture remains absent. This composition creates no writer and does
 * not infer artifact completeness or physical snapshot ownership.
 */
export function composeSnapshotCapability(options: ComposeSnapshotCapabilityOptions): CapsuleSnapshotService {
  const snapshots = new CapsuleSnapshotStore(options.db)
  return new CapsuleSnapshotService(snapshots)
}
