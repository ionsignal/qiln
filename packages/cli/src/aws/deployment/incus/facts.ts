import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { readPreseed, type PreseedDocument } from '../../../host/incus/preseed'
import { affectsStorage, opens } from '../../../host/incus/spec'
import * as journal from '../../../journal/step'
import type { Manifest, PackageChange } from '../../../host/incus/types'
import type { IncusRecord, IncusStep } from './types'

export type StorageState = 'none' | 'initialized' | 'released' | 'unknown'

const STORAGE_LABELS: Record<StorageState, string> = {
  none: 'not opened by Qiln',
  initialized: 'opened and not released (last recorded; not freshly observed)',
  released: 'opened and released by a verified release step (last recorded; not freshly observed)',
  unknown: 'state unknown; an open, initialize, capture, restore, workload stop, or release step is unresolved',
}

function approvedPlan(record: IncusRecord, step: IncusStep) {
  return record.authorizations.find(({ id }) => id === step.authorization)?.plan
}

function storageUnsettled(record: IncusRecord | null): IncusStep[] {
  return unsettled(record).filter(step => affectsStorage(step.action))
}

export function stuck(record: IncusRecord | null): IncusStep[] {
  return journal.stuck(record?.steps ?? [])
}

export function returned(record: IncusRecord | null): IncusStep[] {
  return journal.returned(record?.steps ?? [])
}

export function unsettled(record: IncusRecord | null): IncusStep[] {
  return journal.unsettled(record?.steps ?? [])
}

export function storageTouched(record: IncusRecord | null): boolean {
  return (record?.steps ?? []).some(step => opens(step.action) && step.refusedAt === null)
}

export function opened(record: IncusRecord | null): boolean {
  return (record?.steps ?? []).some(step => opens(step.action) && journal.stateOf(step) === 'verified')
}

export function storageReleased(record: IncusRecord | null): boolean {
  const steps = record?.steps ?? []
  const lastOpening = steps.findLastIndex(step => opens(step.action) && step.refusedAt === null)
  if (lastOpening < 0) {
    return true
  }
  return steps.slice(lastOpening + 1).some(step => step.action === 'release' && journal.stateOf(step) === 'verified')
}

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

export function establishes(record: IncusRecord, step: IncusStep): boolean {
  if (journal.stateOf(step) !== 'verified') {
    return false
  }
  if (step.action === 'initialize') {
    return true
  }
  const plan = approvedPlan(record, step)
  return step.action === 'open' && plan?.kind === 'open' && plan.retained !== null
}

export function retainedPreseedBytes(record: IncusRecord | null): { yaml: string; sha256: string } | null {
  if (record === null) {
    return null
  }
  const step = record.steps.findLast(item => establishes(record, item))
  const plan = step === undefined ? undefined : approvedPlan(record, step)
  if (plan?.kind === 'initialize') {
    return plan.preseed
  }
  return plan?.kind === 'open' ? (plan.retained?.preseed ?? null) : null
}

export function retainedPreseed(record: IncusRecord | null): PreseedDocument | null {
  const bytes = retainedPreseedBytes(record)
  return bytes === null ? null : readPreseed(bytes.yaml)
}

export function closureOf(record: IncusRecord | null): PackageChange[] | null {
  if (record === null) {
    return null
  }
  const step = record.steps.findLast(item => item.action === 'install-packages' && journal.stateOf(item) === 'verified')
  const plan = step === undefined ? undefined : approvedPlan(record, step)
  return plan?.kind === 'packages' ? plan.install : null
}

export function artifactsOf(record: IncusRecord | null): Manifest | null {
  if (record === null) {
    return null
  }
  const step = record.steps.findLast(
    item => (item.action === 'capture' || item.action === 'restore') && journal.stateOf(item) === 'verified',
  )
  const plan = step === undefined ? undefined : approvedPlan(record, step)
  return plan?.kind === 'capture' || plan?.kind === 'restore' ? plan.manifest : null
}

export function incusFacts(record: IncusRecord | null): readonly DiagnosticFact[] {
  const open = unsettled(record)
  const verified = record?.steps.findLast(step => journal.stateOf(step) === 'verified')
  const release = record?.steps.findLast(step => step.action === 'release' && journal.stateOf(step) === 'verified')
  const artifacts = artifactsOf(record)
  return [
    ['Incus storage', STORAGE_LABELS[storageState(record)]],
    ['Last Incus step', verified?.action ?? 'none'],
    ['Last Incus release', release?.verifiedAt ?? 'none'],
    ['Unresolved Incus steps', open.length === 0 ? 'none' : open.map(step => `${step.action} (${journal.stateOf(step)})`).join(', ')],
    [
      'Incus artifacts',
      artifacts === null
        ? 'none captured or restored by this deployment'
        : `${artifacts.length} package files retained (manifest recorded; not freshly observed)`,
    ],
  ]
}

function refusal(record: IncusRecord | null, deploymentId: string): InstallerError {
  return new InstallerError({
    code: 'AWS_INCUS_PREPARATION_UNRESOLVED',
    facts: [['Deployment', deploymentId], ...incusFacts(record)],
    retry: `qiln aws deployment status --id ${deploymentId}`,
  })
}

export function requireNotStuck(record: IncusRecord | null, deploymentId: string): void {
  if (stuck(record).length > 0) {
    throw refusal(record, deploymentId)
  }
}

export function requireStorageNotStuck(record: IncusRecord | null, deploymentId: string): void {
  if (stuck(record).some(step => affectsStorage(step.action))) {
    throw refusal(record, deploymentId)
  }
}

export function requireSettled(record: IncusRecord | null, deploymentId: string): void {
  if (unsettled(record).length > 0) {
    throw refusal(record, deploymentId)
  }
}

export function requireStorageSettled(record: IncusRecord | null, deploymentId: string): void {
  if (storageUnsettled(record).length > 0) {
    throw refusal(record, deploymentId)
  }
}

export function requireStorageReleased(record: IncusRecord | null, deploymentId: string): void {
  requireStorageSettled(record, deploymentId)
  if (storageHeld(record)) {
    throw refusal(record, deploymentId)
  }
}
