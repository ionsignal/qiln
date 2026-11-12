import { INSTALLER_SPEC } from '../../installation/spec'
import { requireNoCollision } from '../../installation/credentials'
import { assertInstance } from '../../installation/instance'
import { inspectInstallation } from '../../installation/state'
import { toInstallerError } from '../../transport/incus/errors'
import { inputsOf } from '../../installation/types'
import { requireBound, type InstallationRecord } from '../../installation/records'
import type { Reporter } from '../../terminal/reporter'
import type { IncusInstance } from '../../transport/incus/types'
import type { HostAccess, IncusAccess, InstallationTarget } from '../../installation/target/types'

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
 * instance with the same checks that planning uses. An operator checkout must be
 * the Qiln Git root. A managed checkout is only reported, with its HEAD beside
 * the restore point as information, and no network call is made. Nothing is
 * changed.
 */
async function verifyRecord(
  record: InstallationRecord,
  { host, incus }: Inspection,
  reporter: Reporter,
  retry: string,
): Promise<void> {
  const inputs = inputsOf(host, record.checkoutPath)
  const { checkout } = host
  requireBound(record, host.binding, inputs, retry)
  if (checkout.kind === 'operator') {
    await checkout.root(record.checkoutPath)
  }
  reporter.row(
    'verified',
    'Installation',
    checkout.kind === 'operator'
      ? `host, architecture and layout match the retained record · checkout ${record.checkoutPath} is the Qiln Git root`
      : 'host, architecture and layout match the retained record',
  )
  if (checkout.kind === 'managed') {
    const head = await checkout.head()
    const restore = record.checkoutCommit ?? 'origin’s current main when none is recorded yet'
    reporter.row(
      head === null ? 'pending' : 'verified',
      'Source checkout',
      head === null
        ? `${checkout.path} is absent and nothing was created · configure restores it from ${restore}`
        : `${checkout.path} · HEAD ${head} · restore point ${record.checkoutCommit ?? 'none'} (information only; HEAD and the working tree are not judged)`,
    )
  }
  const { name } = INSTALLER_SPEC.orchestrator
  if (record.imageFingerprint === null) {
    reporter.row('pending', 'Orchestrator', 'no image is pinned yet, so the instance was not checked')
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
    reporter.row('pending', 'Orchestrator', `${name} is absent and nothing was created`)
    return
  }
  requireNoCollision(instance.config, retry)
  assertInstance(instance, record.imageFingerprint, inputs, retry)
  reporter.row(
    'verified',
    'Orchestrator',
    `${name} · ${instance.status.toLowerCase()} · compatible with the pinned image and installation inputs`,
  )
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
