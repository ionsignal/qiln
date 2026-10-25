import { SCRIPTS, sha256Of } from './recipe'
import { INCUS_SPEC, repositorySource, type IncusAction } from './spec'
import { PACKAGE_SPEC } from '../apt'
import { runStep, type StepOutcome } from '../step'
import { shellCommand } from '../shell'
import { InstallerError } from '../../diagnostic/error'
import type { Remote } from '../../ssh/connections'
import type { ApprovedPlan } from './types'

/**
 * An action that does not belong to its approved plan, or bytes that no longer
 * match their approved digest, are defects of the caller or the recipe, never
 * operator-correctable input.
 */
function defect(): never {
  throw new InstallerError({
    code: 'INTERNAL_ERROR',
  })
}

/**
 * The transport has no stdin, so file contents travel as base64 arguments that
 * the script decodes and re-checks against the approved digest.
 */
function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function argumentsOf(action: IncusAction, plan: ApprovedPlan): string[] {
  const { keyFile, keyUrl, keySha256, sourceFile } = INCUS_SPEC.repository
  switch (action) {
    case 'add-repository': {
      if (plan.kind !== 'repository') {
        return defect()
      }
      const source = repositorySource(plan.architecture)
      if (plan.key.url !== keyUrl || plan.key.sha256 !== keySha256 || sha256Of(source) !== plan.source.sha256) {
        return defect()
      }
      return [keyFile, plan.key.url, plan.key.sha256, sourceFile, base64(source), plan.source.sha256]
    }
    case 'refresh-lists':
      return plan.kind === 'repository' ? [sourceFile] : defect()
    case 'install-packages': {
      if (plan.kind !== 'packages') {
        return defect()
      }
      const packages = plan.install.map(change => `${change.name}=${change.version}`)
      if (!packages.every(item => PACKAGE_SPEC.test(item))) {
        return defect()
      }
      return packages
    }
    case 'initialize':
      if (plan.kind !== 'initialize' || sha256Of(plan.preseed.yaml) !== plan.preseed.sha256) {
        return defect()
      }
      return [base64(plan.preseed.yaml), plan.preseed.sha256, plan.pool, plan.guid]
    case 'release':
      return plan.kind === 'release' ? [] : defect()
  }
}

/**
 * Runs one approved step as one privileged script. The script and its limits
 * come from the allowlist and the arguments from the approved plan, so no
 * caller supplies a command. A failed SSH channel ends the connection, so
 * nothing is retried here.
 */
export async function apply(remote: Remote, plan: ApprovedPlan, action: IncusAction): Promise<StepOutcome> {
  const { run } = INCUS_SPEC.steps[action]
  const command = shellCommand(SCRIPTS[run.script], argumentsOf(action, plan), { privileged: true })
  return await runStep(remote, command, {
    timeoutMs: run.timeoutMs,
    maxOutputBytes: INCUS_SPEC.apply.maxOutputBytes,
    refusals: run.refusals,
    refusalCodes: INCUS_SPEC.apply.refusalCodes,
  })
}
