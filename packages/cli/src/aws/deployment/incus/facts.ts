import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { readPreseed, type PreseedDocument } from '../../../remote/incus/preseed'
import { affectsStorage } from '../../../remote/incus/spec'
import * as journal from '../journal/step'
import type { IncusRecord, IncusStep } from './types'

/**
 * The last recorded state of Incus storage, not a fresh observation. `unknown`
 * means an initialize or release step is unsettled.
 */
export type StorageState = 'none' | 'initialized' | 'released' | 'unknown'

const STORAGE_LABELS: Record<StorageState, string> = {
  none: 'not initialized by Qiln',
  initialized: 'initialized and not released (last recorded; not freshly observed)',
  released: 'initialized and released (last recorded; not freshly observed)',
  unknown: 'state unknown; an initialize or release step is unresolved',
}

/**
 * Steps whose effect is unknown and which only an operator can resolve: open
 * or uncertain. Nothing clears them, and they are never replayed or resumed.
 */
export function stuck(record: IncusRecord | null): IncusStep[] {
  return journal.stuck(record?.steps ?? [])
}

/**
 * Steps that exited zero but were not verified yet. A fresh inspection can
 * verify them, which is accounting and not replay.
 */
export function returned(record: IncusRecord | null): IncusStep[] {
  return journal.returned(record?.steps ?? [])
}

/**
 * Stuck plus returned steps.
 */
export function unsettled(record: IncusRecord | null): IncusStep[] {
  return journal.unsettled(record?.steps ?? [])
}

function storageUnsettled(record: IncusRecord | null): IncusStep[] {
  return unsettled(record).filter(step => affectsStorage(step.action))
}

/**
 * Any initialization that was not refused may have left Incus data on the pool.
 */
export function storageTouched(record: IncusRecord | null): boolean {
  return (record?.steps ?? []).some(step => step.action === 'initialize' && step.refusedAt === null)
}

/**
 * Storage counts as released when it was never touched, or when a release was
 * verified after the last initialization that was not refused.
 */
export function storageReleased(record: IncusRecord | null): boolean {
  const steps = record?.steps ?? []
  const initialized = steps.findLastIndex(step => step.action === 'initialize' && step.refusedAt === null)
  return (
    initialized < 0 ||
    steps.slice(initialized + 1).some(step => step.action === 'release' && journal.stateOf(step) === 'verified')
  )
}

/**
 * Incus was initialized and not released, so a release is needed before the
 * pool can be exported.
 */
export function storageHeld(record: IncusRecord | null): boolean {
  return storageTouched(record) && !storageReleased(record)
}

export function storageState(record: IncusRecord | null): StorageState {
  if (storageUnsettled(record).length > 0) {
    return 'unknown'
  }
  if (!storageTouched(record)) {
    return 'none'
  }
  return storageReleased(record) ? 'released' : 'initialized'
}

/**
 * The approved preseed of the verified initialization, read back from the
 * retained bytes. Null means no initialization was verified.
 */
export function retainedPreseed(record: IncusRecord | null): PreseedDocument | null {
  const step = record?.steps.findLast(item => item.action === 'initialize' && journal.stateOf(item) === 'verified')
  const plan = step === undefined ? undefined : record?.authorizations.find(({ id }) => id === step.authorization)?.plan
  return plan?.kind === 'initialize' ? readPreseed(plan.preseed.yaml) : null
}

export function incusFacts(record: IncusRecord | null): readonly DiagnosticFact[] {
  const open = unsettled(record)
  const verified = record?.steps.findLast(step => journal.stateOf(step) === 'verified')
  return [
    ['Incus storage', STORAGE_LABELS[storageState(record)]],
    ['Last verified Incus step', verified?.action ?? 'none'],
    ['Unresolved Incus steps', open.length === 0 ? 'none' : open.map(step => `${step.action} (${journal.stateOf(step)})`).join(', ')],
  ]
}

function refusal(record: IncusRecord | null, deploymentId: string): InstallerError {
  return new InstallerError({
    code: 'AWS_INCUS_PREPARATION_UNRESOLVED',
    facts: [['Deployment', deploymentId], ...incusFacts(record)],
    retry: `qiln aws deployment status --id ${deploymentId}`,
  })
}

/**
 * A stuck step blocks further preparation, while a returned one is verified by
 * the next fresh inspection.
 */
export function requireNotStuck(record: IncusRecord | null, deploymentId: string): void {
  if (stuck(record).length > 0) {
    throw refusal(record, deploymentId)
  }
}

/**
 * Only storage-affecting uncertainty blocks removal and disconnect, so an
 * interrupted repository, refresh, or package step never makes a deployment
 * unmanageable.
 */
export function requireStorageSettled(record: IncusRecord | null, deploymentId: string): void {
  if (storageUnsettled(record).length > 0) {
    throw refusal(record, deploymentId)
  }
}

/**
 * Handing off the volume or removing the host needs Incus storage whose state
 * is known and that was released.
 */
export function requireStorageReleased(record: IncusRecord | null, deploymentId: string): void {
  requireStorageSettled(record, deploymentId)
  if (storageHeld(record)) {
    throw refusal(record, deploymentId)
  }
}
