import { CapsuleSnapshotService } from '../snapshot/service'
import { CapsuleSnapshotStore } from '../snapshot/store'
import type { QilnPersistence, QilnTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeSnapshotCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  persistence: QilnPersistence<TDatabase, TTables>
}

/**
 * Composes read-only committed capsule snapshot history.
 *
 * Snapshot capture remains absent. This composition creates no writer and does
 * not infer artifact completeness or physical snapshot ownership.
 */
export function composeSnapshotCapability<TDatabase extends PostgresJsDatabase, TTables extends QilnTables>(
  options: ComposeSnapshotCapabilityOptions<TDatabase, TTables>,
): CapsuleSnapshotService {
  const snapshots = new CapsuleSnapshotStore(options.persistence)
  return new CapsuleSnapshotService(snapshots)
}
