import { ZFS_SPEC, arcLine, type StepAction } from './spec'
import { SCRIPTS } from './recipe'
import { SshError } from '../../ssh/failure'
import { shellCommand } from '../shell'
import { InstallerError } from '../../diagnostic/error'
import type { Remote } from '../../ssh/connections'
import type { ApprovedPlan } from './types'

/**
 * - returned: exited zero. This is not verified until a fresh inspection agrees.
 * - refused: an authored refusal, or a connection that ended before dispatch.
 *   The whole step had no effect.
 * - uncertain: anything else. A nonzero exit does not show that nothing
 *   changed, and a step cut off after dispatch may have run partly or fully.
 *   `exitCode` is null when no exit status was reported.
 *
 * `cause` carries the SSH failure, if any, so cancellation can be rethrown.
 */
export type ApplyOutcome =
  | { kind: 'returned' }
  | { kind: 'refused'; reason: string; cause: SshError | null }
  | { kind: 'uncertain'; reason: string; exitCode: number | null; cause: SshError | null }

/**
 * Package specs are approved evidence, but they become arguments to APT, so
 * only plain `name=version` words are accepted.
 */
const PACKAGE_SPEC = /^[a-z0-9][a-z0-9+.-]*=[A-Za-z0-9][A-Za-z0-9.+:~-]*$/

/**
 * An action that does not belong to its approved plan is a defect of the
 * caller, never an operator-correctable input.
 */
function defect(): never {
  throw new InstallerError({
    code: 'INTERNAL_ERROR',
  })
}

function argumentsOf(action: StepAction, plan: ApprovedPlan): string[] {
  switch (action) {
    case 'install-packages': {
      if (plan.kind !== 'prerequisites') {
        return defect()
      }
      const packages = plan.install.map(change => `${change.name}=${change.version}`)
      if (!packages.every(item => PACKAGE_SPEC.test(item))) {
        return defect()
      }
      return packages
    }
    case 'write-arc':
      return plan.kind === 'prerequisites' ? ['write', ZFS_SPEC.arc.file, arcLine(plan.arc.maxBytes)] : defect()
    case 'load-module':
      return []
    case 'apply-arc':
      return plan.kind === 'prerequisites' ? ['apply', String(plan.arc.maxBytes)] : defect()
    case 'create-pool': {
      if (plan.kind !== 'create') {
        return defect()
      }
      const { pool } = ZFS_SPEC
      return [
        plan.pool,
        plan.disk.path,
        plan.disk.volumeId,
        String(plan.ashift),
        plan.autotrim,
        plan.dataset.compression,
        plan.dataset.atime,
        pool.acltype,
        pool.xattr,
        pool.mountpoint,
        pool.cachefile,
      ]
    }
    case 'import-pool':
      return plan.kind === 'import'
        ? [plan.pool, plan.guid, plan.disk.path, plan.disk.volumeId, plan.disk.member]
        : defect()
    case 'enable-scrub':
      return plan.kind === 'create' || plan.kind === 'import' ? [plan.pool] : defect()
    case 'export-pool':
      return plan.kind === 'export' ? [plan.pool, plan.guid] : defect()
  }
}

/**
 * Runs one approved step as one privileged script. The script and its limits
 * come from the allowlist and the arguments from the approved plan, so no
 * caller supplies a command. A failed SSH channel ends the connection, so
 * nothing is retried here.
 */
export async function apply(remote: Remote, plan: ApprovedPlan, action: StepAction): Promise<ApplyOutcome> {
  const { run } = ZFS_SPEC.steps[action]
  const refusals: Readonly<Record<number, string>> = run.refusals
  const { first, last } = ZFS_SPEC.apply.refusalCodes
  const command = shellCommand(SCRIPTS[run.script], argumentsOf(action, plan), { privileged: true })
  try {
    const { exitCode } = await remote.exec(command, {
      timeoutMs: run.timeoutMs,
      maxOutputBytes: ZFS_SPEC.apply.maxOutputBytes,
    })
    if (exitCode === 0) {
      return { kind: 'returned' }
    }
    if (exitCode >= first && exitCode <= last) {
      return {
        kind: 'refused',
        reason: refusals[exitCode] ?? 'The script refused before changing anything.',
        cause: null,
      }
    }
    return { kind: 'uncertain', reason: `The script exited with code ${exitCode}.`, exitCode, cause: null }
  } catch (error: unknown) {
    if (!(error instanceof SshError)) {
      throw error
    }
    return error.remoteStarted
      ? {
          kind: 'uncertain',
          reason: 'The connection or remote operation did not complete reliably.',
          exitCode: null,
          cause: error,
        }
      : { kind: 'refused', reason: 'The connection ended before the step was dispatched.', cause: error }
  }
}
