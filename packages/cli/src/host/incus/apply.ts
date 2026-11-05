import { SCRIPTS, sha256Of } from './recipe'
import { INCUS_SPEC, repositoryPreferences, repositorySource, sysctlOverride, type IncusAction } from './spec'
import { PACKAGE_SPEC } from '../apt'
import { ARTIFACTS_MOUNTPOINT, STATE_MOUNTPOINT } from '../mount'
import { ZFS_SPEC } from '../zfs/spec'
import { rangeWords } from './idmap'
import { shellCommand } from '../shell'
import { manifestWords } from './artifacts'
import { guardOf, type Guard } from './activation'
import { runStep, type StepOutcome } from '../step'
import { InstallerError } from '../../diagnostic/error'
import { accessPlanSchema, instanceKey, repositoryOf, type ApprovedPlan, type OpenPlan } from './types'
import type { Remote } from '../../transport/ssh/connections'

function defect(): never {
  throw new InstallerError({
    code: 'INTERNAL_ERROR',
  })
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function approvedGuard(plan: OpenPlan): Guard {
  const files = guardOf(plan)
  if (
    files.expectation.sha256 !== plan.guard.expectation.sha256 ||
    files.check.sha256 !== plan.guard.check.sha256 ||
    files.dropIn.sha256 !== plan.guard.dropIn.sha256
  ) {
    return defect()
  }
  return files
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
      if (plan.kind !== 'open' || !plan.install) {
        return defect()
      }
      const { expectation, check, dropIn } = approvedGuard(plan)
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
      const approved = repositoryOf(plan)
      if (approved === null) {
        return defect()
      }
      const source = repositorySource(approved.architecture)
      if (
        approved.key.url !== keyUrl ||
        approved.key.sha256 !== keySha256 ||
        sha256Of(source) !== approved.source.sha256
      ) {
        return defect()
      }
      return [keyFile, approved.key.url, approved.key.sha256, sourceFile, base64(source), approved.source.sha256]
    }
    case 'refresh-lists':
      return repositoryOf(plan) === null ? defect() : [sourceFile]
    case 'pin-versions': {
      if (plan.kind !== 'packages' && plan.kind !== 'restore') {
        return defect()
      }
      const preferences = repositoryPreferences(plan.preferences.version)
      if (sha256Of(preferences) !== plan.preferences.sha256) {
        return defect()
      }
      return [preferencesFile, base64(preferences), plan.preferences.sha256]
    }
    case 'install-packages': {
      if (plan.kind !== 'packages') {
        return defect()
      }
      const packages = plan.install.map(change => `${change.name}=${change.version}`)
      if (!packages.every(item => PACKAGE_SPEC.test(item))) {
        return defect()
      }
      return [INCUS_SPEC.stageDirectory, ...packages]
    }
    case 'capture': {
      if (plan.kind !== 'capture') {
        return defect()
      }
      return [
        'capture',
        plan.pool,
        plan.guid,
        ZFS_SPEC.layout.artifacts,
        plan.datasets.artifacts,
        ARTIFACTS_MOUNTPOINT,
        INCUS_SPEC.stageDirectory,
        ...manifestWords(plan.manifest),
      ]
    }
    case 'restore': {
      if (plan.kind !== 'restore') {
        return defect()
      }
      return [
        'restore',
        plan.pool,
        plan.guid,
        ZFS_SPEC.layout.artifacts,
        plan.datasets.artifacts,
        ARTIFACTS_MOUNTPOINT,
        ...manifestWords(plan.manifest),
      ]
    }
    case 'open': {
      if (plan.kind !== 'open') {
        return defect()
      }
      const { expectation, check } = approvedGuard(plan)
      if (plan.retained !== null && sha256Of(plan.retained.preseed.yaml) !== plan.retained.preseed.sha256) {
        return defect()
      }
      const { open, retained, idmap } = INCUS_SPEC
      const mode = plan.retained === null ? 'fresh' : 'preserved'
      const ranges = plan.retained === null ? [] : rangeWords(plan.retained.baseline.allocations)
      return [
        mode,
        check.path,
        check.sha256,
        expectation.path,
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
        layout.artifacts,
        plan.datasets.artifacts,
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
 * come from the allowlist and the arguments from the approved plan, so no caller
 * supplies a command. A failed SSH channel ends the connection, so nothing is
 * retried here.
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
