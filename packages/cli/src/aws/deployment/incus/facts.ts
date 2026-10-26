import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { readPreseed, type PreseedDocument } from '../../../host/incus/preseed'
import { affectsStorage } from '../../../host/incus/spec'
import * as journal from '../../../journal/step'
import type { IncusRecord, IncusStep } from './types'

/**
 * The last recorded state of Incus storage, not a fresh observation. `unknown`
 * means an initialize or release step is unsettled.
 */
export type StorageState = 'none' | 'initialized' | 'released' | 'unknown'

const STORAGE_LABELS: Record<StorageState, string> = {
  none: 'not initialized by Qiln',
  initialized: 'initialized and not released (last recorded; not freshly observed)',
  released: 'initialized and released or observed inactive (last recorded; not freshly observed)',
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
 * Storage counts as released when it was never touched, or when, after the last
 * initialization that was not refused, a release was verified or every Incus
 * unit was observed inactive. Both are point-in-time evidence. An observation
 * is not an executed step and settles nothing: unresolved steps are judged
 * separately.
 */
export function storageReleased(record: IncusRecord | null): boolean {
  const steps = record?.steps ?? []
  const initialized = steps.findLastIndex(step => step.action === 'initialize' && step.refusedAt === null)
  if (initialized < 0) {
    return true
  }
  const observedAt = record?.quiescence?.observedAt
  return (
    (observedAt !== undefined && observedAt >= steps[initialized].fencedAt) ||
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
    ['Last Incus inactivity observation', record?.quiescence?.observedAt ?? 'none'],
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
 * Removal starts here: only a storage-affecting step with an unknown effect
 * blocks it. A step that exited zero is left for the release check to verify
 * from a fresh inspection, which is settlement and not replay.
 */
export function requireStorageNotStuck(record: IncusRecord | null, deploymentId: string): void {
  if (stuck(record).some(step => affectsStorage(step.action))) {
    throw refusal(record, deploymentId)
  }
}

/**
 * Any unsettled Incus step blocks a handoff to installation, because a returned
 * step has not yet been verified by a fresh inspection.
 */
export function requireSettled(record: IncusRecord | null, deploymentId: string): void {
  if (unsettled(record).length > 0) {
    throw refusal(record, deploymentId)
  }
}

/**
 * Only storage-affecting uncertainty blocks disconnect, so an interrupted
 * repository, refresh, or package step never makes a deployment unmanageable.
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
