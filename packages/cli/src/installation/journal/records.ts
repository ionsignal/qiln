import { INSTALLER_SPEC } from '../spec'
import { isAppendOnly, isHistoryConsistent } from '../../journal/history'
import { stateOf } from '../../journal/step'
import { isErrorCode } from '../../guards'
import { encodeRecord, sameJson } from '../../json'
import { InstallerError } from '../../diagnostic/error'
import { readChild, writeChild, type Dir } from '../../state/files'
import { currentUserId } from '../../state/user'
import { requireInstallationLock } from '../state'
import { actionsOf, evidenceSchema, type ConfigureEvidence } from './types'
import type { InstallationRecord } from '../records'

function invalid(retry: string): never {
  throw new InstallerError({
    code: 'INSTALLATION_EVIDENCE_INVALID',
    retry,
  })
}

function bindingOf(record: InstallationRecord): ConfigureEvidence['binding'] {
  return { host: record.host }
}

/**
 * Evidence of an installation with no configuration history. Its binding is
 * copied from the installation record, so it can never describe another host.
 */
export function blank(record: InstallationRecord): ConfigureEvidence {
  return {
    version: INSTALLER_SPEC.evidenceVersion,
    binding: bindingOf(record),
    authorizations: [],
    steps: [],
    operations: [],
  }
}

function isConsistent(evidence: ConfigureEvidence, record: InstallationRecord): boolean {
  const { operations, steps } = evidence
  return (
    sameJson(evidence.binding, bindingOf(record)) &&
    new Set(operations.map(operation => operation.step)).size === operations.length &&
    operations.every(operation => steps.some(step => step.id === operation.step)) &&
    isHistoryConsistent(evidence, actionsOf)
  )
}

function parse(value: unknown, record: InstallationRecord, retry: string): ConfigureEvidence {
  const parsed = evidenceSchema.safeParse(value)
  if (!parsed.success || !isConsistent(parsed.data, record)) {
    return invalid(retry)
  }
  return parsed.data
}

/**
 * Lock-free so status can show evidence while an operation is running. An absent
 * file means no configuration history, and any other failure fails closed.
 */
export async function read(
  directory: Dir,
  record: InstallationRecord,
  retry: string,
): Promise<ConfigureEvidence | null> {
  let value: unknown
  try {
    const snapshot = await readChild(directory, INSTALLER_SPEC.state.configureFileName, {
      owner: currentUserId(),
      mode: 0o600,
      minSize: 1,
      maxSize: INSTALLER_SPEC.limits.evidence,
    })
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)) as unknown
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return null
    }
    return invalid(retry)
  }
  return parse(value, record, retry)
}

/**
 * An operation reference is recorded once, and only for the newest step while
 * that step is still open. Earlier references never change.
 */
function operationRecorded(before: ConfigureEvidence, after: ConfigureEvidence): boolean {
  const added = after.operations.length - before.operations.length
  if (added === 0) {
    return sameJson(before.operations, after.operations)
  }
  const step = after.steps.at(-1)
  return (
    added === 1 &&
    sameJson(before.operations, after.operations.slice(0, -1)) &&
    after.steps.length === before.steps.length &&
    step !== undefined &&
    after.operations.at(-1)?.step === step.id &&
    stateOf(step) === 'open'
  )
}

/**
 * The write rule: the binding is fixed, history grows only through the shared
 * append-only rule, and operation references are added only as described above.
 * Both records are already validated.
 */
function requireTransition(before: ConfigureEvidence, after: ConfigureEvidence, retry: string): void {
  if (!sameJson(before.binding, after.binding) || !isAppendOnly(before, after) || !operationRecorded(before, after)) {
    invalid(retry)
  }
}

/**
 * Replaces the evidence only through a permitted transition, under the
 * installation lock held by this process. `directory` is the installation's own
 * directory.
 */
export async function save(
  directory: Dir,
  record: InstallationRecord,
  evidence: ConfigureEvidence,
  retry: string,
): Promise<void> {
  await requireInstallationLock(directory, retry)
  const next = parse(evidence, record, retry)
  requireTransition((await read(directory, record, retry)) ?? blank(record), next, retry)
  await writeChild(
    directory,
    INSTALLER_SPEC.state.configureFileName,
    encodeRecord(next, 'INSTALLATION_EVIDENCE_INVALID', INSTALLER_SPEC.limits.evidence),
    0o600,
  )
}
