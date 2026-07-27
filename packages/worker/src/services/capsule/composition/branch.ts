import { CapsuleBranchRuntimeObserver } from '../branch/observer'
import { CapsuleBranchRuntimeReconciler } from '../branch/reconciler'
import { CapsuleBranchRuntimeService } from '../branch/service'
import { CapsuleBranchStore } from '../branch/store'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { CapsuleBranchEventPublisher } from '../events/branch'
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
}

/**
 * Composes runtime behavior for existing editable capsule branches.
 *
 * This capability owns observation and runtime reconciliation only. Root branch
 * creation and future snapshot-based branch forks remain operation concerns.
 */
export function composeBranchCapability<TDatabase extends PostgresJsDatabase, TTables extends CapsuleTables>(
  options: ComposeBranchCapabilityOptions<TDatabase, TTables>,
): CapsuleBranchRuntimeService {
  const branches = new CapsuleBranchStore(options.persistence)
  const observer = new CapsuleBranchRuntimeObserver(options.incus, options.project)
  const reconciler = new CapsuleBranchRuntimeReconciler({
    branches,
    events: options.branchEvents,
    observer,
  })
  return new CapsuleBranchRuntimeService({
    branches,
    events: options.branchEvents,
    observer,
    reconciler,
    incus: options.incus,
    project: options.project,
  })
}
