import { SnapshotAbandonment } from '../operations/snapshot/abandonment'
import { SnapshotExecutor } from '../operations/snapshot/executor'
import { SnapshotRepository } from '../operations/snapshot/persistence'
import { SnapshotProvider } from '../operations/snapshot/provider'
import { SnapshotSubmission } from '../operations/snapshot/submission'
import { CapsuleSnapshotService } from '../snapshot/service'
import { CapsuleSnapshotStore } from '../snapshot/store'
import type { OperationSupervisor } from '../../../coordination'
import type { IncusClient } from '../../../incus/client'
import type {
  CapsuleBranchEventPublisher,
  CapsuleLifecycleEventPublisher,
  CapsuleOperationEventPublisher,
} from '../events'
import type { CapsuleOperationStepStore } from '../operations/shared/operationStepStore'
import type { PreviewGate } from '../routing/preview/gate'
import type { CapsuleChannel, CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeSnapshotCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
}

export interface ComposeCreateSnapshotCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  incus: IncusClient
  channel: CapsuleChannel
  supervisor: OperationSupervisor
  operationSteps: CapsuleOperationStepStore<TDatabase, TTables>
  operationEvents: CapsuleOperationEventPublisher
  lifecycleEvents: CapsuleLifecycleEventPublisher
  branchEvents: CapsuleBranchEventPublisher
  previewGate: PreviewGate<TDatabase, TTables>
}

export interface ComposedCreateSnapshotCapability {
  submission: SnapshotSubmission
  abandonment: SnapshotAbandonment
}

/**
 * Snapshot history is a PostgreSQL-only capability. It cannot inspect live
 * branches, walk provider filesystems, or authorize artifact-content reads.
 */
export function composeSnapshotCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeSnapshotCapabilityOptions<TDatabase, TTables>,
): CapsuleSnapshotService {
  return new CapsuleSnapshotService(new CapsuleSnapshotStore(options.persistence))
}

/**
 * Composes Create Snapshot independently from history reads.
 *
 * Construction performs no SQL, provider calls, command registration,
 * scheduling, or invalidation publication.
 */
export function composeCreateSnapshotCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeCreateSnapshotCapabilityOptions<TDatabase, TTables>,
): ComposedCreateSnapshotCapability {
  const repository = new SnapshotRepository(options.persistence, options.previewGate)
  const provider = new SnapshotProvider({
    incus: options.incus,
    repository,
  })
  const executor = new SnapshotExecutor({
    repository,
    provider,
    channel: options.channel,
    steps: options.operationSteps,
    operationEvents: options.operationEvents,
    lifecycleEvents: options.lifecycleEvents,
    branchEvents: options.branchEvents,
  })
  return {
    submission: new SnapshotSubmission(
      repository,
      executor,
      options.supervisor,
      options.operationEvents,
      options.lifecycleEvents,
      options.branchEvents,
    ),
    abandonment: new SnapshotAbandonment({
      repository,
      operationEvents: options.operationEvents,
      lifecycleEvents: options.lifecycleEvents,
      branchEvents: options.branchEvents,
    }),
  }
}
