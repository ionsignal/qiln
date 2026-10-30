import { INSTALLER_SPEC } from '../spec'
import { isAppendOnly, isHistoryConsistent } from '../../journal/history'
import { stateOf } from '../../journal/step'
import { isErrorCode } from '../../guards'
import { encodeRecord, sameJson } from '../../json'
import { InstallerError } from '../../diagnostic/error'
import { readChild, writeChild, type Dir } from '../../state/files'
import { currentUserId } from '../../state/user'
import { requireInstallationLock } from '../state'
import { sameHost, type InstallationRecord } from '../records'
import { actionsOf, evidenceSchema, type ConfigureEvidence } from './types'

function invalid(retry: string): never {
  throw new InstallerError({
    code: 'INSTALLATION_EVIDENCE_INVALID',
    retry,
  })
}

/**
 * Evidence of an installation with no configuration history.
 */
export function blank(): ConfigureEvidence {
  return {
    version: INSTALLER_SPEC.evidenceVersion,
    authorizations: [],
    steps: [],
    operations: [],
  }
}

/**
 * Every authorization names the current host or one of the earlier hosts that
 * the installation record retains, so evidence can never describe another
 * installation.
 */
function isConsistent(evidence: ConfigureEvidence, record: InstallationRecord): boolean {
  const { authorizations, operations, steps } = evidence
  const hosts = [record.host, ...record.history.map(entry => entry.host)]
  return (
    authorizations.every(({ host }) => hosts.some(known => sameHost(known, host))) &&
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
 * The write rule: history grows only through the shared append-only rule, a new
 * authorization names the installation's current host, and operation references
 * are added only as described above. Both records are already validated.
 */
function requireTransition(
  before: ConfigureEvidence,
  after: ConfigureEvidence,
  record: InstallationRecord,
  retry: string,
): void {
  const added = after.authorizations.slice(before.authorizations.length)
  if (
    !isAppendOnly(before, after) ||
    !operationRecorded(before, after) ||
    !added.every(({ host }) => sameHost(host, record.host))
  ) {
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
  requireTransition((await read(directory, record, retry)) ?? blank(), next, record, retry)
  await writeChild(
    directory,
    INSTALLER_SPEC.state.configureFileName,
    encodeRecord(next, 'INSTALLATION_EVIDENCE_INVALID', INSTALLER_SPEC.limits.evidence),
    0o600,
  )
}
