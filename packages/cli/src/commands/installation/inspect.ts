import { INSTALLER_SPEC } from '../../install/spec'
import { requireNoCollision } from '../../install/credentials'
import { assertInstance } from '../../install/instance'
import { requireBound, type InstallationRecord } from '../../install/records'
import { inspectInstallation } from '../../install/state'
import { toInstallerError } from '../../incus/errors'
import type { IncusInstance } from '../../incus/types'
import type { InstallationInputs } from '../../install/types'
import type { Reporter } from '../../terminal/reporter'
import type { HostAccess, IncusAccess, InstallationTarget } from './target'

/**
 * A target whose checks have all passed, and the retained installation record
 * bound to it, if any. The target parts are reachable only while the callback
 * of `withInspection` runs.
 */
export interface Inspection {
  host: HostAccess
  incus: IncusAccess
  record: InstallationRecord | null
}

/**
 * The read-only preflight shared by inspection and configuration: the host, the
 * recorded installation state, the Incus daemon, and the layout's storage and
 * network. It changes nothing, so the target is only held while `use` runs.
 */
export async function withInspection<T>(
  target: InstallationTarget,
  reporter: Reporter,
  retry: string,
  use: (inspection: Inspection) => Promise<T>,
): Promise<T> {
  reporter.section('Preflight')
  return await target.withHost(reporter, retry, async host => {
    const state = await inspectInstallation(target.name, host.binding, retry)
    reporter.row(
      'verified',
      'Installer state',
      state.record === null
        ? 'no installation is recorded and nothing was created'
        : `installation '${target.name}' is bound to this host and its state has restrictive ownership and permissions`,
    )
    return await host.withIncus(async incus => {
      await incus.verifyLayout()
      return await use({ host, incus, record: state.record })
    })
  })
}

/**
 * Checks a retained installation against the live target: its binding, its
 * checkout, and, when an image is pinned and the orchestrator exists, the
 * instance with the same checks that planning uses. Nothing is changed.
 */
async function verifyRecord(
  record: InstallationRecord,
  { host, incus }: Inspection,
  reporter: Reporter,
  retry: string,
): Promise<void> {
  const inputs: InstallationInputs = {
    architecture: host.architecture,
    layout: host.layout,
    sourceRoot: record.checkoutPath,
  }
  requireBound(record, host.binding, inputs, retry)
  await host.checkout(record.checkoutPath)
  reporter.row(
    'verified',
    'Installation',
    `host, architecture and layout match the retained record · checkout ${record.checkoutPath} is the Qiln Git root`,
  )
  const { name } = INSTALLER_SPEC.orchestrator
  if (record.imageFingerprint === null) {
    reporter.row('working', 'Orchestrator', 'no image is pinned yet, so the instance was not checked')
    return
  }
  let instance: IncusInstance | null
  try {
    instance = await incus.client.getInstanceOrNull(name)
  } catch (error: unknown) {
    throw toInstallerError(error, {
      check: 'orchestrator instance',
      operation: `inspect the '${name}' instance`,
      rerun: retry,
    })
  }
  if (instance === null) {
    reporter.row('working', 'Orchestrator', `${name} is absent and nothing was created`)
    return
  }
  requireNoCollision(instance.config, retry)
  assertInstance(instance, record.imageFingerprint, inputs, retry)
  reporter.row('verified', 'Orchestrator', `${name} · compatible with the pinned image and installation inputs`)
}

export async function inspect(target: InstallationTarget, reporter: Reporter): Promise<void> {
  const retry = target.retry.inspect
  await withInspection(target, reporter, retry, async inspection => {
    if (inspection.record !== null) {
      await verifyRecord(inspection.record, inspection, reporter, retry)
    }
  })
  reporter.summary('Inspection completed without changing host, installer, or Incus state.')
}
