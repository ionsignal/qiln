import { CapsuleBranchRuntimeObserver } from '../branch/observer'
import { CapsuleBranchRuntimeReconciler } from '../branch/reconciler'
import { CapsuleBranchRuntimeService } from '../branch/service'
import { CapsuleBranchStore } from '../branch/store'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher } from '../events/branch'
import type { PreviewGate } from '../routing/preview/gate'
import type { PreviewService } from '../routing/preview/service'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface ComposeBranchCapabilityOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  incus: IncusClient
  project: ProjectService
  branchEvents: CapsuleBranchEventPublisher
  previews: PreviewService
  previewGate: PreviewGate<TDatabase, TTables>
}

/**
 * Composes runtime behavior for existing editable capsule branches.
 *
 * Branch runtime observation, reconciliation, and transition policy remain in
 * the branch capability. Preview Caddy mechanics remain in routing, while the
 * shared PreviewGate keeps branch shutdown transactionally dependent on proven
 * preview withdrawal.
 */
export function composeBranchCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeBranchCapabilityOptions<TDatabase, TTables>,
): CapsuleBranchRuntimeService {
  const branchStore = new CapsuleBranchStore(options.persistence, options.previewGate)
  const observer = new CapsuleBranchRuntimeObserver(options.incus, options.project)
  const reconciler = new CapsuleBranchRuntimeReconciler({
    branches: branchStore,
    events: options.branchEvents,
    observer,
  })
  return new CapsuleBranchRuntimeService({
    branches: branchStore,
    events: options.branchEvents,
    observer,
    reconciler,
    previews: options.previews,
    incus: options.incus,
    project: options.project,
  })
}
