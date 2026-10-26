import { SshError } from '../transport/ssh/failure'
import { cloudInitClean, parseArchitecture, parseCloudInit, parseOsRelease, shortText } from './parse'
import type { CommandResult, Remote } from '../transport/ssh/connections'
import type { ExecLimits } from '../transport/ssh/options'

export type CheckStatus = 'passed' | 'failed' | 'unverified' | 'observed' | 'not-run'
export type CheckId = 'cloud-init' | 'os-release' | 'architecture' | 'login' | 'sudo'

export interface Check {
  id: CheckId
  label: string
  status: CheckStatus
  detail: string
}

interface Verdict {
  status: CheckStatus
  detail: string
}

interface Probe {
  id: CheckId
  label: string
  command: string
  limits?: Partial<ExecLimits>
  judge(result: CommandResult, account: string): Verdict
}

const EXPECTED_OS = { id: 'ubuntu', versionId: '26.04' } as const

/**
 * Cloud-init is the only probe that waits for the guest. Every other probe
 * keeps the connection's default deadline and output bound.
 */
const CLOUD_INIT_LIMITS: Partial<ExecLimits> = {
  timeoutMs: 600_000,
  maxOutputBytes: 65_536,
}

const NOT_RUN = 'not run; the connection ended earlier'

function nonzero(result: CommandResult, subject: string): Verdict | null {
  return result.exitCode === 0 ? null : { status: 'failed', detail: `${subject} exited with code ${result.exitCode}` }
}

function judgeCloudInit(result: CommandResult): Verdict {
  const failed = nonzero(result, 'cloud-init status')
  if (failed) {
    return failed
  }
  const report = parseCloudInit(result.stdout)
  if (report === null) {
    return { status: 'unverified', detail: 'the status output was not in the expected form' }
  }
  if (cloudInitClean(report)) {
    return { status: 'passed', detail: 'status done; no errors or recoverable errors reported' }
  }
  return {
    status: 'failed',
    detail: `status ${shortText(report.status)} / ${shortText(report.extendedStatus)}; ${report.errors} errors; recoverable errors ${report.recoverableErrors === 0 ? 'none' : 'reported'}`,
  }
}

function judgeOsRelease(result: CommandResult): Verdict {
  const failed = nonzero(result, 'reading /etc/os-release')
  if (failed) {
    return failed
  }
  const release = parseOsRelease(result.stdout)
  if (release === null) {
    return { status: 'unverified', detail: 'ID and VERSION_ID could not be read from the file' }
  }
  if (release.id === EXPECTED_OS.id && release.versionId === EXPECTED_OS.versionId) {
    return { status: 'passed', detail: `ID=${EXPECTED_OS.id} VERSION_ID=${EXPECTED_OS.versionId}` }
  }
  return {
    status: 'failed',
    detail: `reports ID=${shortText(release.id)} VERSION_ID=${shortText(release.versionId)}; expected ${EXPECTED_OS.id} ${EXPECTED_OS.versionId}`,
  }
}

/**
 * The retained host plan has no architecture expectation, so the value is an
 * observation and is never compared with anything.
 */
function judgeArchitecture(result: CommandResult): Verdict {
  const failed = nonzero(result, 'uname -m')
  if (failed) {
    return failed
  }
  const architecture = parseArchitecture(result.stdout)
  return architecture === null
    ? { status: 'unverified', detail: 'no valid architecture token was returned' }
    : { status: 'observed', detail: `${architecture} observed; compatibility not compared` }
}

function judgeLogin(result: CommandResult, account: string): Verdict {
  const failed = nonzero(result, 'id -un')
  if (failed) {
    return failed
  }
  return result.stdout.trim() === account
    ? { status: 'passed', detail: `administrative key accepted; account ${account}` }
    : { status: 'failed', detail: 'returned a different account name than the recorded bootstrap user' }
}

function judgeSudo(result: CommandResult): Verdict {
  const failed = nonzero(result, 'sudo -n')
  if (failed) {
    return failed
  }
  return result.stdout.trim() === '0'
    ? { status: 'passed', detail: 'this invocation returned uid 0; the effective sudo policy was not inspected' }
    : { status: 'failed', detail: 'the invocation did not return uid 0' }
}

/**
 * Declaration order is execution order. Cloud-init runs first because account
 * and sudo results taken before it finishes could be misleading.
 */
const PROBES: readonly Probe[] = [
  {
    id: 'cloud-init',
    label: 'Cloud-init',
    command: 'cloud-init status --wait --format json',
    limits: CLOUD_INIT_LIMITS,
    judge: judgeCloudInit,
  },
  { id: 'os-release', label: 'Operating system', command: 'cat /etc/os-release', judge: judgeOsRelease },
  { id: 'architecture', label: 'Architecture', command: 'uname -m', judge: judgeArchitecture },
  { id: 'login', label: 'Admin login', command: 'id -un', judge: judgeLogin },
  { id: 'sudo', label: 'Sudo', command: 'sudo -n -u root -- /usr/bin/id -u', judge: judgeSudo },
]

/**
 * Runs the fixed read-only probes in order. A nonzero result does not stop
 * independent probes. A failed command channel destroys the connection, so the
 * remaining probes are not run. The interrupted probe is unverified when it
 * may have started. Cancellation propagates to the caller, which receives no
 * partial report.
 */
export async function runBaseline(remote: Remote, account: string): Promise<Check[]> {
  const checks: Check[] = []
  let connectionEnded = false
  for (const { id, label, command, limits, judge } of PROBES) {
    if (connectionEnded) {
      checks.push({ id, label, status: 'not-run', detail: NOT_RUN })
      continue
    }
    try {
      checks.push({ id, label, ...judge(await remote.exec(command, limits), account) })
    } catch (error: unknown) {
      if (!(error instanceof SshError) || error.kind === 'cancelled') {
        throw error
      }
      connectionEnded = true
      checks.push(
        error.remoteStarted
          ? { id, label, status: 'unverified', detail: 'interrupted; the remote outcome is unknown' }
          : { id, label, status: 'not-run', detail: NOT_RUN },
      )
    }
  }
  return checks
}

/**
 * The status each check must have for the baseline to be met. The
 * architecture is only ever observed, never passed, so its probe failing or
 * being unverified still leaves the baseline unmet.
 */
const REQUIRED_STATUS: Record<CheckId, CheckStatus> = {
  'cloud-init': 'passed',
  'os-release': 'passed',
  architecture: 'observed',
  login: 'passed',
  sudo: 'passed',
}

export function unmetChecks(checks: readonly Check[]): Check[] {
  return checks.filter(check => check.status !== REQUIRED_STATUS[check.id])
}
