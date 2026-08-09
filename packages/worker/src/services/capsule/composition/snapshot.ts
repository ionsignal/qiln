import { CapsuleSnapshotArtifactStore } from '../snapshot/artifact'
import { CapsuleSnapshotReadService } from '../snapshot/read'
import { CapsuleSnapshotSelector } from '../snapshot/select'
import { CapsuleSnapshotService } from '../snapshot/service'
import { CapsuleSnapshotStore } from '../snapshot/store'
import type { IncusClient } from '../../../incus/client'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeSnapshotCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  incus: IncusClient
}

/**
 * Composes committed capsule snapshot history and immutable agent inspection.
 *
 * Snapshot Capture remains a separate operation capability. This composition
 * creates no writer and does not infer artifact completeness or physical
 * snapshot ownership.
 */
export function composeSnapshotCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeSnapshotCapabilityOptions<TDatabase, TTables>,
): CapsuleSnapshotService {
  const snapshots = new CapsuleSnapshotStore(options.persistence)
  const artifacts = new CapsuleSnapshotArtifactStore(options.persistence)
  const selector = new CapsuleSnapshotSelector(snapshots, artifacts)
  const reader = new CapsuleSnapshotReadService(artifacts, options.incus)
  return new CapsuleSnapshotService(snapshots, reader, selector)
}
