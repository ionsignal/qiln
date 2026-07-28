import { CapsuleSnapshotService } from '../snapshot/service'
import { CapsuleSnapshotStore } from '../snapshot/store'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeSnapshotCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
}

/**
 * Composes read-only committed capsule snapshot history.
 *
 * Snapshot Capture remains a separate operation capability. This composition
 * creates no writer and does not infer artifact completeness or physical
 * snapshot ownership.
 */
export function composeSnapshotCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeSnapshotCapabilityOptions<TDatabase, TTables>,
): CapsuleSnapshotService {
  const snapshots = new CapsuleSnapshotStore(options.persistence)
  return new CapsuleSnapshotService(snapshots)
}
