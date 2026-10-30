import { InstallerError, type DiagnosticFact, type InstallerErrorCode } from '../../../diagnostic/error'
import { isPoolAction, type StepAction } from '../../../host/zfs/spec'
import { establishesPool, type ZfsRecord, type ZfsStep } from './types'
import * as journal from '../../../journal/step'

/**
 * Steps that hand the pool or its state mount back to the host.
 */
const RELEASES: readonly StepAction[] = ['unmount-state', 'export-pool']

/**
 * The pool's last recorded state, not a fresh observation. `unknown` means a
 * pool-affecting step is unsettled, or packages were installed where lineage
 * evidence expects a pool that the package may have imported.
 */
export type PoolState = 'none' | 'imported' | 'exported' | 'unknown'

/**
 * Steps whose effect is unknown and which only an operator can resolve: open or
 * uncertain. Nothing clears them, and they are never replayed or resumed.
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

function poolStuck(record: ZfsRecord | null): ZfsStep[] {
  return stuck(record).filter(step => isPoolAction(step.action))
}

/**
 * Pool-affecting steps that exited zero and wait for a fresh inspection to
 * verify them.
 */
export function poolReturned(record: ZfsRecord | null): ZfsStep[] {
  return returned(record).filter(step => isPoolAction(step.action))
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

function verified(step: ZfsStep): boolean {
  return journal.stateOf(step) === 'verified'
}

/**
 * The steps after the last verified create or import, with that step.
 */
function sinceEstablished(record: ZfsRecord | null): { established: ZfsStep; later: ZfsStep[] } | null {
  const steps = record?.steps ?? []
  const index = steps.findLastIndex(step => establishesPool(step.action) && verified(step))
  return index < 0 ? null : { established: steps[index], later: steps.slice(index + 1) }
}

/**
 * The pool was last created or imported with a verified step, its datasets
 * were verified when it was created, its scrub timer was verified after that,
 * and no unmount or export has been attempted since. Like the pool state, this
 * is the last recorded outcome and not a fresh observation. The state dataset
 * may still be unmounted.
 */
export function staged(record: ZfsRecord | null): boolean {
  const since = sinceEstablished(record)
  if (since === null) {
    return false
  }
  const required: StepAction[] =
    since.established.action === 'create-pool' ? ['create-datasets', 'enable-scrub'] : ['enable-scrub']
  return (
    required.every(action => since.later.some(step => step.action === action && verified(step))) &&
    !since.later.some(step => RELEASES.includes(step.action) && step.refusedAt === null)
  )
}

/**
 * The pool is staged and the state dataset was mounted with a verified step
 * after it was established.
 */
export function prepared(record: ZfsRecord | null): boolean {
  const since = sinceEstablished(record)
  return staged(record) && since !== null && since.later.some(step => step.action === 'mount-state' && verified(step))
}

function poolDisclosure(record: ZfsRecord | null): string {
  const state = poolState(record)
  const pool = record?.pool ?? null
  if (pool === null) {
    return state === 'unknown'
      ? 'unknown; a pool-affecting step is unresolved or a package install may have imported a pool'
      : 'none recorded'
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
    [
      'Unresolved ZFS steps',
      open.length === 0 ? 'none' : open.map(step => `${step.action} (${journal.stateOf(step)})`).join(', '),
    ],
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
 * A stuck step of any action blocks further preparation, while a returned one
 * is verified by the next fresh inspection. Removal that must release the host
 * over SSH also calls this before connecting, because the journal accepts no
 * new work after an unresolved step.
 */
export function requireNotStuck(record: ZfsRecord | null, deploymentId: string): void {
  if (stuck(record).length > 0) {
    throw refusal('ZFS_PREPARATION_UNRESOLVED', record, deploymentId)
  }
}

/**
 * Removal starts here: only a pool-affecting step with an unknown effect blocks
 * this gate. Removal that then needs the host released over SSH is additionally
 * refused by `requireNotStuck`. A returned pool step is verified from a fresh
 * inspection before the pool is judged, which is settlement and not replay.
 */
export function requirePoolNotStuck(record: ZfsRecord | null, deploymentId: string): void {
  if (poolStuck(record).length > 0) {
    throw refusal('ZFS_PREPARATION_UNRESOLVED', record, deploymentId)
  }
}

/**
 * Only pool-affecting uncertainty blocks disconnect, so an interrupted package
 * or ARC step never blocks disconnecting a deployment.
 */
export function requirePoolSettled(record: ZfsRecord | null, deploymentId: string): void {
  if (poolUnsettled(record).length > 0) {
    throw refusal('ZFS_PREPARATION_UNRESOLVED', record, deploymentId)
  }
}

/**
 * Removing the host or handing off its volume needs a pool whose state is known
 * and that is not left imported.
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
