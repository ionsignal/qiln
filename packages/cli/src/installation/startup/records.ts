import { INSTALLER_SPEC } from '../spec'
import { isAppendOnly, isHistoryConsistent } from '../../journal/history'
import { isErrorCode } from '../../guards'
import { encodeRecord } from '../../json'
import { InstallerError } from '../../diagnostic/error'
import { readChild, writeChild, type Dir } from '../../state/files'
import { currentUserId } from '../../state/user'
import { requireInstallationLock } from '../state'
import { actionsOf, evidenceSchema, type StartupEvidence } from './types'

function invalid(retry: string): never {
  throw new InstallerError({
    code: 'INSTALLATION_EVIDENCE_INVALID',
    retry,
  })
}

/**
 * Evidence of an installation that was never started.
 */
export function blank(): StartupEvidence {
  return { version: INSTALLER_SPEC.evidenceVersion, authorizations: [], steps: [] }
}

function parse(value: unknown, retry: string): StartupEvidence {
  const parsed = evidenceSchema.safeParse(value)
  if (!parsed.success || !isHistoryConsistent(parsed.data, actionsOf)) {
    return invalid(retry)
  }
  return parsed.data
}

/**
 * Lock-free so status can show evidence while an operation is running. An absent
 * file means no startup history, and any other failure fails closed.
 */
export async function read(directory: Dir, retry: string): Promise<StartupEvidence | null> {
  let value: unknown
  try {
    const snapshot = await readChild(directory, INSTALLER_SPEC.state.startupFileName, {
      owner: currentUserId(),
      mode: 0o600,
      minSize: 1,
      maxSize: INSTALLER_SPEC.limits.startup,
    })
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)) as unknown
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return null
    }
    return invalid(retry)
  }
  return parse(value, retry)
}

/**
 * Replaces the evidence only through the shared append-only rule, under the
 * installation lock held by this process.
 */
export async function save(directory: Dir, evidence: StartupEvidence, retry: string): Promise<void> {
  await requireInstallationLock(directory, retry)
  const next = parse(evidence, retry)
  if (!isAppendOnly((await read(directory, retry)) ?? blank(), next)) {
    return invalid(retry)
  }
  await writeChild(
    directory,
    INSTALLER_SPEC.state.startupFileName,
    encodeRecord(next, 'INSTALLATION_EVIDENCE_INVALID', INSTALLER_SPEC.limits.startup),
    0o600,
  )
}
