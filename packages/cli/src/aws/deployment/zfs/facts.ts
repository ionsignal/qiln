import { InstallerError, type DiagnosticFact, type InstallerErrorCode } from '../../../diagnostic/error'
import { isPoolAction } from '../../../remote/zfs/spec'
import * as journal from '../journal/step'
import { establishesPool, type ZfsRecord, type ZfsStep } from './types'

/**
 * The pool's last recorded state, not a fresh observation. `unknown` means a
 * pool-affecting step is unsettled, or packages were installed where lineage
 * evidence expects a pool that the package may have imported.
 */
export type PoolState = 'none' | 'imported' | 'exported' | 'unknown'

/**
 * Steps whose effect is unknown and which only an operator can resolve: open
 * or uncertain. Nothing clears them, and they are never replayed or resumed.
 */
export function stuck(record: ZfsRecord | null): ZfsStep[] {
  return journal.stuck(record?.steps ?? [])
}

/**
 * Steps that exited zero but were not verified yet. A fresh inspection can
 * verify them, which is accounting and not replay.
 */
export function returned(record: ZfsRecord | null): ZfsStep[] {
  return journal.returned(record?.steps ?? [])
}

/**
 * Stuck plus returned steps.
 */
export function unsettled(record: ZfsRecord | null): ZfsStep[] {
  return journal.unsettled(record?.steps ?? [])
}

function poolUnsettled(record: ZfsRecord | null): ZfsStep[] {
  return unsettled(record).filter(step => isPoolAction(step.action))
}

function expectsPool(record: ZfsRecord, step: ZfsStep): boolean {
  const plan = record.authorizations.find(({ id }) => id === step.authorization)?.plan
  return plan !== undefined && plan.kind === 'prerequisites' && plan.expectedPool !== null
}

/**
 * Installing packages can import pools through package-started units. Any
 * install that was not refused, even an interrupted one, may have imported a
 * pool that lineage evidence expects, so the pool stays unknown until a later
 * verified pool action observes it.
 */
function poolExposed(record: ZfsRecord): boolean {
  const installed = record.steps.findLastIndex(
    step => step.action === 'install-packages' && step.refusedAt === null && expectsPool(record, step),
  )
  return (
    installed >= 0 &&
    !record.steps.slice(installed + 1).some(step => isPoolAction(step.action) && journal.stateOf(step) === 'verified')
  )
}

export function poolState(record: ZfsRecord | null): PoolState {
  if (record === null) {
    return 'none'
  }
  if (poolUnsettled(record).length > 0 || poolExposed(record)) {
    return 'unknown'
  }
  const last = record.steps.findLast(step => isPoolAction(step.action) && journal.stateOf(step) === 'verified')
  if (last === undefined) {
    return 'none'
  }
  return last.action === 'export-pool' ? 'exported' : 'imported'
}

/**
 * The pool was last created or imported with a verified step, its scrub timer
 * was verified after that, and no export has been attempted since. Like the pool
 * state, this is the last recorded outcome and not a fresh observation.
 */
export function prepared(record: ZfsRecord | null): boolean {
  const steps = record?.steps ?? []
  const established = steps.findLastIndex(step => establishesPool(step.action) && journal.stateOf(step) === 'verified')
  if (established < 0) {
    return false
  }
  const later = steps.slice(established + 1)
  return (
    later.some(step => step.action === 'enable-scrub' && journal.stateOf(step) === 'verified') &&
    !later.some(step => step.action === 'export-pool' && step.refusedAt === null)
  )
}

function poolDisclosure(record: ZfsRecord | null): string {
  const state = poolState(record)
  const pool = record?.pool ?? null
  if (pool === null) {
    return state === 'unknown' ? 'unknown; a pool-affecting step is unresolved or a package install may have imported a pool' : 'none recorded'
  }
  const labels: Record<PoolState, string> = {
    none: 'not verified',
    imported: 'imported',
    exported: 'cleanly exported',
    unknown: 'state unknown; a pool-affecting step is unresolved or a package install may have imported a pool',
  }
  return `${pool.name} · GUID ${pool.guid} · ${labels[state]} (last recorded; not freshly observed)`
}

export function zfsFacts(record: ZfsRecord | null): readonly DiagnosticFact[] {
  const open = unsettled(record)
  return [
    ['ZFS pool', poolDisclosure(record)],
    ['Unresolved ZFS steps', open.length === 0 ? 'none' : open.map(step => `${step.action} (${journal.stateOf(step)})`).join(', ')],
  ]
}

function refusal(code: InstallerErrorCode, record: ZfsRecord | null, deploymentId: string): InstallerError {
  return new InstallerError({
    code,
    facts: [['Deployment', deploymentId], ...zfsFacts(record)],
    retry: `qiln aws deployment status --id ${deploymentId}`,
  })
}

/**
 * Any unsettled step blocks further preparation.
 */
export function requireSettled(record: ZfsRecord | null, deploymentId: string): void {
  if (unsettled(record).length > 0) {
    throw refusal('ZFS_PREPARATION_UNRESOLVED', record, deploymentId)
  }
}

/**
 * A stuck step blocks further preparation, while a returned one is verified by
 * the next fresh inspection.
 */
export function requireNotStuck(record: ZfsRecord | null, deploymentId: string): void {
  if (stuck(record).length > 0) {
    throw refusal('ZFS_PREPARATION_UNRESOLVED', record, deploymentId)
  }
}

/**
 * Only pool-affecting uncertainty blocks disconnect, so an interrupted package
 * or ARC step never makes a deployment unmanageable.
 */
export function requirePoolSettled(record: ZfsRecord | null, deploymentId: string): void {
  if (poolUnsettled(record).length > 0) {
    throw refusal('ZFS_PREPARATION_UNRESOLVED', record, deploymentId)
  }
}

/**
 * Removing the host or handing off its volume needs a pool whose state is
 * known and that is not left imported.
 */
export function requirePoolReleased(record: ZfsRecord | null, deploymentId: string): void {
  requirePoolSettled(record, deploymentId)
  const state = poolState(record)
  if (state === 'unknown') {
    throw refusal('ZFS_PREPARATION_UNRESOLVED', record, deploymentId)
  }
  if (state === 'imported') {
    throw refusal('ZFS_EXPORT_REQUIRED', record, deploymentId)
  }
}
