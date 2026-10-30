import { guardOf } from './activation'
import { rangeWords } from './idmap'
import { SCRIPTS, sha256Of } from './recipe'
import { INCUS_SPEC, repositoryPreferences, repositorySource, sysctlOverride, type IncusAction } from './spec'
import { PACKAGE_SPEC } from '../apt'
import { STATE_MOUNTPOINT } from '../mount'
import { ZFS_SPEC } from '../zfs/spec'
import { runStep, type StepOutcome } from '../step'
import { shellCommand } from '../shell'
import { InstallerError } from '../../diagnostic/error'
import { accessPlanSchema, instanceKey, type ApprovedPlan } from './types'
import type { Remote } from '../../transport/ssh/connections'

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
  const { keyFile, keyUrl, keySha256, sourceFile, preferencesFile } = INCUS_SPEC.repository
  switch (action) {
    case 'close': {
      if (plan.kind !== 'close') {
        return defect()
      }
      const override = sysctlOverride()
      if (sha256Of(override) !== plan.sysctl.sha256) {
        return defect()
      }
      return [INCUS_SPEC.sysctl.file, base64(override), plan.sysctl.sha256, ...INCUS_SPEC.units]
    }
    case 'guard': {
      if (plan.kind !== 'guard') {
        return defect()
      }
      const { expectation, check, dropIn } = guardOf(plan)
      if (
        expectation.sha256 !== plan.expectation.sha256 ||
        check.sha256 !== plan.check.sha256 ||
        dropIn.sha256 !== plan.dropIn.sha256
      ) {
        return defect()
      }
      return [
        expectation.path,
        base64(expectation.text),
        expectation.sha256,
        check.path,
        base64(check.text),
        check.sha256,
        dropIn.path,
        base64(dropIn.text),
        dropIn.sha256,
      ]
    }
    case 'add-repository': {
      if (plan.kind !== 'repository') {
        return defect()
      }
      const source = repositorySource(plan.architecture)
      const preferences = repositoryPreferences(plan.architecture)
      if (
        plan.key.url !== keyUrl ||
        plan.key.sha256 !== keySha256 ||
        sha256Of(source) !== plan.source.sha256 ||
        sha256Of(preferences) !== plan.preferences.sha256
      ) {
        return defect()
      }
      return [
        keyFile,
        plan.key.url,
        plan.key.sha256,
        sourceFile,
        base64(source),
        plan.source.sha256,
        preferencesFile,
        base64(preferences),
        plan.preferences.sha256,
      ]
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
    case 'open': {
      if (plan.kind !== 'open' || sha256Of(SCRIPTS.startup) !== plan.check.sha256) {
        return defect()
      }
      if (plan.retained !== null && sha256Of(plan.retained.preseed.yaml) !== plan.retained.preseed.sha256) {
        return defect()
      }
      const { guard, open, retained, idmap } = INCUS_SPEC
      const mode = plan.retained === null ? 'fresh' : 'preserved'
      const ranges = plan.retained === null ? [] : rangeWords(plan.retained.baseline.allocations)
      return [
        mode,
        guard.checkFile,
        plan.check.sha256,
        guard.expectationFile,
        STATE_MOUNTPOINT,
        String(idmap.minimum),
        ...retained.metadata,
        '--',
        ...ranges,
        '--',
        ...open.units,
      ]
    }
    case 'initialize': {
      if (plan.kind !== 'initialize' || sha256Of(plan.preseed.yaml) !== plan.preseed.sha256) {
        return defect()
      }
      const { name, subnet } = INCUS_SPEC.network
      const { layout } = ZFS_SPEC
      return [
        base64(plan.preseed.yaml),
        plan.preseed.sha256,
        plan.pool,
        plan.guid,
        layout.state,
        plan.datasets.state,
        layout.incus,
        plan.datasets.incus,
        STATE_MOUNTPOINT,
        name,
        subnet,
      ]
    }
    case 'grant-access':
      if (plan.kind !== 'access' || !accessPlanSchema.safeParse(plan).success || plan.group !== INCUS_SPEC.access.group) {
        return defect()
      }
      return [plan.account, plan.group]
    case 'stop-workloads':
      return plan.kind === 'release'
        ? [String(INCUS_SPEC.release.stopTimeoutSeconds), ...plan.instances.map(instanceKey)]
        : defect()
    case 'release':
      return plan.kind === 'release' ? [...INCUS_SPEC.units] : defect()
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
