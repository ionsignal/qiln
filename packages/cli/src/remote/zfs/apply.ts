import { ZFS_SPEC, arcLine, type StepAction } from './spec'
import { SCRIPTS } from './recipe'
import { PACKAGE_SPEC } from '../apt'
import { runStep, type StepOutcome } from '../step'
import { shellCommand } from '../shell'
import { InstallerError } from '../../diagnostic/error'
import type { Remote } from '../../ssh/connections'
import type { ApprovedPlan } from './types'

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
export async function apply(remote: Remote, plan: ApprovedPlan, action: StepAction): Promise<StepOutcome> {
  const { run } = ZFS_SPEC.steps[action]
  const command = shellCommand(SCRIPTS[run.script], argumentsOf(action, plan), { privileged: true })
  return await runStep(remote, command, {
    timeoutMs: run.timeoutMs,
    maxOutputBytes: ZFS_SPEC.apply.maxOutputBytes,
    refusals: run.refusals,
    refusalCodes: ZFS_SPEC.apply.refusalCodes,
  })
}
