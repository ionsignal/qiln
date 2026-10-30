import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { readPreseed, type PreseedDocument } from '../../../host/incus/preseed'
import { affectsStorage, opens } from '../../../host/incus/spec'
import * as journal from '../../../journal/step'
import type { IncusRecord, IncusStep } from './types'

/**
 * The last recorded state of Incus storage, not a fresh observation. `unknown`
 * means an open, initialize, workload stop, or release step is unsettled.
 */
export type StorageState = 'none' | 'initialized' | 'released' | 'unknown'

const STORAGE_LABELS: Record<StorageState, string> = {
  none: 'not opened by Qiln',
  initialized: 'opened and not released (last recorded; not freshly observed)',
  released: 'opened and released by a verified release step (last recorded; not freshly observed)',
  unknown: 'state unknown; an open, initialize, workload stop, or release step is unresolved',
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
 * Any open or initialization that was not refused may have let the daemon write
 * Incus data to the state directory and the pool.
 */
export function storageTouched(record: IncusRecord | null): boolean {
  return (record?.steps ?? []).some(step => opens(step.action) && step.refusedAt === null)
}

/**
 * A verified open or initialization let the daemon run, so closed-host
 * protection no longer keeps it closed.
 */
export function opened(record: IncusRecord | null): boolean {
  return (record?.steps ?? []).some(step => opens(step.action) && journal.stateOf(step) === 'verified')
}

/**
 * Storage counts as released when it was never touched, or when a release step
 * was verified after the last open or initialization that was not refused. A
 * verified release stops the daemon and masks every unit, so it is the only
 * evidence of release: an observed inactivity is not, because nothing then
 * shows that the instances were stopped or that the host stays closed. The
 * evidence is point-in-time, and unresolved steps are judged separately.
 */
export function storageReleased(record: IncusRecord | null): boolean {
  const steps = record?.steps ?? []
  const lastOpening = steps.findLastIndex(step => opens(step.action) && step.refusedAt === null)
  if (lastOpening < 0) {
    return true
  }
  return steps.slice(lastOpening + 1).some(step => step.action === 'release' && journal.stateOf(step) === 'verified')
}

/**
 * Incus was opened and not released, so a release is needed before the pool can
 * be exported.
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
 * Whether a verified step is the one that establishes the baseline and the
 * server identity: an initialization, or the open of a preserved installation.
 */
export function establishes(record: IncusRecord, step: IncusStep): boolean {
  if (journal.stateOf(step) !== 'verified') {
    return false
  }
  if (step.action === 'initialize') {
    return true
  }
  const plan = record.authorizations.find(({ id }) => id === step.authorization)?.plan
  return step.action === 'open' && plan?.kind === 'open' && plan.retained !== null
}

/**
 * The approved preseed bytes of the newest establishing step, read back from
 * the retained evidence. Null means no such step was verified.
 */
export function retainedPreseedBytes(record: IncusRecord | null): { yaml: string; sha256: string } | null {
  if (record === null) {
    return null
  }
  const step = record.steps.findLast(item => establishes(record, item))
  const plan = step === undefined ? undefined : record.authorizations.find(({ id }) => id === step.authorization)?.plan
  if (plan?.kind === 'initialize') {
    return plan.preseed
  }
  return plan?.kind === 'open' ? (plan.retained?.preseed ?? null) : null
}

/**
 * The expected state of the verified initialization, or of the verified open of
 * a preserved installation. Null means neither was verified.
 */
export function retainedPreseed(record: IncusRecord | null): PreseedDocument | null {
  const bytes = retainedPreseedBytes(record)
  return bytes === null ? null : readPreseed(bytes.yaml)
}

export function incusFacts(record: IncusRecord | null): readonly DiagnosticFact[] {
  const open = unsettled(record)
  const verified = record?.steps.findLast(step => journal.stateOf(step) === 'verified')
  const release = record?.steps.findLast(step => step.action === 'release' && journal.stateOf(step) === 'verified')
  return [
    ['Incus storage', STORAGE_LABELS[storageState(record)]],
    ['Last verified Incus step', verified?.action ?? 'none'],
    ['Last verified Incus release', release?.verifiedAt ?? 'none'],
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
 * A stuck step of any action blocks further preparation, while a returned one
 * is verified by the next fresh inspection. Removal that must stop Incus also
 * calls this before connecting, because the journal accepts no new work after
 * an unresolved step.
 */
export function requireNotStuck(record: IncusRecord | null, deploymentId: string): void {
  if (stuck(record).length > 0) {
    throw refusal(record, deploymentId)
  }
}

/**
 * Removal starts here: only a storage-affecting step with an unknown effect
 * blocks this gate. Once Incus was opened, removal is additionally refused
 * by `requireNotStuck`. A step that exited zero is left for the release check
 * to verify from a fresh inspection, which is settlement and not replay.
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
 * protection, repository, refresh, or package step never makes a deployment
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
