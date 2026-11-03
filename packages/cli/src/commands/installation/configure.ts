import { INSTALLER_SPEC } from '../../installation/spec'
import { withInspection } from './inspect'
import { approvalLabel, reportPlan } from './plan'
import { rootOf } from '../../installation/checkout/judge'
import { requireIncusExtensions } from '../../installation/preflight/incus'
import { withImageSource, type InstallerImageSelection } from '../../installation/image'
import { isEmpty } from '../../installation/journal/types'
import { readRoster, validateRoster } from '../../installation/roster'
import { acquireInstallationLock, loadInstallation, registerInstallation } from '../../installation/state'
import { Configurer, type ConfigureResult } from '../../installation/configure'
import { Prompts } from '../../terminal/prompts'
import type { InstallationInputs } from '../../installation/types'
import type { FileSnapshot } from '../../state/files'
import type { InstallerLock } from '../../state/lock'
import type { Reporter } from '../../terminal/reporter'
import type { InstallationTarget } from '../../installation/target/types'

/**
 * `sourcePath` is the operator's checkout of a local target. It is null for an
 * AWS target, whose checkout is managed by Qiln.
 */
export interface ConfigureOptions {
  sourcePath: string | null
  authorizedKeysPath?: string
  image: InstallerImageSelection
}

/**
 * Rows are derived from the plan that was applied, or from the empty plan of an
 * installation that already matched.
 */
function reportResult(
  reporter: Reporter,
  inputs: InstallationInputs,
  managed: boolean,
  { plan, observation }: ConfigureResult,
): void {
  const { layout, architecture } = inputs
  const { name, sourceMountPath } = INSTALLER_SPEC.orchestrator
  const replaced = plan.image.replace !== null
  if (plan.checkout !== null) {
    reporter.row(
      'created',
      'Source checkout',
      `${inputs.sourceRoot} · commit ${plan.checkout.commit} · ${plan.checkout.pin ? 'origin main, recorded as the restore point' : 'recorded restore point restored'}`,
    )
  } else if (managed) {
    reporter.row(
      'reused',
      'Source checkout',
      `${inputs.sourceRoot} · managed checkout present · HEAD and the working tree are not judged`,
    )
  }
  reporter.row(
    plan.image.import ? 'imported' : 'verified',
    'Image',
    replaced
      ? `${plan.fingerprint} · ${architecture.incus} container image · explicit development replacement completed`
      : `${plan.fingerprint} · ${architecture.incus} container image`,
  )
  reporter.row(
    'verified',
    'Image pin',
    `persisted full fingerprint in ${INSTALLER_SPEC.state.installationFileName} of installation '${INSTALLER_SPEC.state.localName}'`,
  )
  if (replaced) {
    reporter.notice(
      'The approved plan deleted the previous managed alias target after the replacement was imported and checked. Other aliases attached to that image may also have been removed, and no automatic rollback was attempted.',
    )
  }
  reporter.row(
    plan.network ? 'created' : 'reused',
    'Network',
    `${layout.network.name} · ${layout.network.ipv4Subnet} · managed bridge`,
  )
  reporter.row(
    plan.volume ? 'created' : 'reused',
    'PostgreSQL volume',
    `${layout.postgres.volumeName} · ${layout.postgres.config.size} · persistent custom volume`,
  )
  reporter.row(
    plan.instance ? 'created' : 'reused',
    'Orchestrator',
    `${name} · ${architecture.incus} container · ${observation.instance?.value.status ?? 'unknown'}`,
  )
  reporter.row('verified', 'Source device', `${inputs.sourceRoot} → ${sourceMountPath} · writable shifted disk`)
  reporter.row(
    plan.credentials === 'generate' ? 'created' : plan.credentials === 'roster' ? 'transferred' : 'reused',
    'Local credentials',
    plan.credentials === 'generate'
      ? 'generated and retained four protected credential files'
      : plan.credentials === 'roster'
        ? 'replaced only the retained authorized-key roster'
        : 'reused the complete retained credential set',
  )
  reporter.row(
    plan.deliver ? 'transferred' : 'reused',
    'Instance credentials',
    plan.deliver
      ? 'delivered four credentials through one guarded complete instance update'
      : 'instance credentials already matched the retained local source of truth',
  )
  reporter.row('verified', 'Final state', `${name} · configured · stopped`)
  reporter.summary(
    isEmpty(plan)
      ? 'Qiln installation already matched its configuration and is stopped.'
      : 'Qiln installation configured and stopped.',
  )
}

/**
 * Observes the target first, then displays one installation plan and applies
 * it only after an explicit approval. Registration, locking and image-source
 * handling are shared by every target. Cancellation is owned by the target.
 */
export async function configure(
  target: InstallationTarget,
  options: ConfigureOptions,
  reporter: Reporter,
): Promise<void> {
  const { retry, signal } = target
  await withInspection(target, reporter, retry.configure, async ({ host, incus }) => {
    requireIncusExtensions(incus.extensions, retry.inspect)
    const sourceRoot = await rootOf(host.checkout, options.sourcePath, retry.configure)
    const inputs: InstallationInputs = {
      architecture: host.architecture,
      layout: host.layout,
      sourceRoot,
    }
    let roster: FileSnapshot | null = null
    if (options.authorizedKeysPath !== undefined) {
      roster = await validateRoster(
        await readRoster(options.authorizedKeysPath, retry.configure),
        host.sshKeygen,
        retry.configure,
      )
    }
    if (host.checkout.kind === 'operator') {
      reporter.row('verified', 'Source', `validated Git checkout '${sourceRoot}'`)
    } else {
      reporter.row(
        'working',
        'Source',
        `managed checkout path '${sourceRoot}' on the target · its state is observed with the plan`,
      )
    }
    if (roster !== null) {
      reporter.row('verified', 'Authorized keys', `validated stable roster · ${roster.size} bytes`)
    }
    const directory = await registerInstallation(target.name, host.binding, inputs, retry.inspect)
    let lock: InstallerLock | undefined
    try {
      lock = await acquireInstallationLock(directory, retry.inspect)
      const installation = await loadInstallation(directory, host.binding, inputs, retry.inspect)
      const result = await withImageSource(options.image, async imageSource => {
        const prompts = new Prompts(signal, retry.configure, reporter)
        const configurer = await Configurer.open({
          directory,
          installation,
          client: incus.client,
          inputs,
          checkout: host.checkout,
          source: imageSource,
          sshKeygen: host.sshKeygen,
          roster,
          hooks: {
            show: plan => reportPlan(reporter, { plan, inputs, source: imageSource }),
            approve: plan => prompts.approve(approvalLabel(plan)),
          },
          retry,
        })
        return await configurer.run(signal)
      })
      reportResult(reporter, inputs, host.checkout.kind === 'managed', result)
    } finally {
      await lock?.release()
    }
  })
}
