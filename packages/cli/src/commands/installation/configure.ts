import { INSTALLER_SPEC } from '../../install/spec'
import { withInspection } from './inspect'
import { approvalLabel, reportPlan } from './plan'
import { requireIncusExtensions } from '../../checks/incus'
import { withImageSource, type InstallerImageSelection } from '../../install/image'
import { isEmpty } from '../../install/journal/types'
import { readRoster, validateRoster } from '../../install/roster'
import { acquireInstallationLock, loadInstallation, registerInstallation } from '../../install/state'
import { Configurer, type ConfigureResult } from '../../install/configure'
import { Prompts, withCancellation } from '../../terminal/prompts'
import type { InstallationInputs } from '../../install/types'
import type { FileSnapshot } from '../../state/files'
import type { InstallerLock } from '../../state/lock'
import type { Reporter } from '../../terminal/reporter'
import type { InstallationTarget } from './target'

export interface ConfigureOptions {
  sourcePath: string
  image: InstallerImageSelection
  authorizedKeysPath?: string
}

/**
 * Rows are derived from the plan that was applied, or from the empty plan of an
 * installation that already matched.
 */
function reportResult(reporter: Reporter, inputs: InstallationInputs, { plan, observation }: ConfigureResult): void {
  const { layout, architecture } = inputs
  const { name, sourceMountPath } = INSTALLER_SPEC.orchestrator
  const replaced = plan.image.replace !== null
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
  reporter.notice(
    'The operator-selected image is trusted guest code. Qiln has not established provenance, authenticity, guest compatibility, or bootstrap readiness.',
  )
  if (replaced) {
    reporter.notice(
      'The approved plan deleted the previous managed alias target. Other aliases attached to that image may also have been removed, and no automatic rollback was attempted.',
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
 * handling are shared by every target.
 */
export async function configure(
  target: InstallationTarget,
  options: ConfigureOptions,
  reporter: Reporter,
): Promise<void> {
  const { retry } = target
  await withInspection(target, reporter, retry.configure, async ({ host, incus }) => {
    requireIncusExtensions(incus.extensions, retry.inspect)

    const sourceRoot = await host.checkout(options.sourcePath)
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
    reporter.row('verified', 'Source', `validated Git checkout '${sourceRoot}'`)
    if (roster !== null) {
      reporter.row('verified', 'Authorized keys', `validated stable roster · ${roster.size} bytes`)
    }

    const directory = await registerInstallation(target.name, host.binding, inputs, retry.inspect)
    let lock: InstallerLock | undefined
    try {
      lock = await acquireInstallationLock(directory, retry.inspect)
      const installation = await loadInstallation(directory, host.binding, inputs, retry.inspect)
      const result = await withCancellation(signal =>
        withImageSource(options.image, async imageSource => {
          const prompts = new Prompts(signal, retry.configure, reporter)
          const configurer = await Configurer.open({
            directory,
            installation,
            client: incus.client,
            inputs,
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
        }),
      )
      reportResult(reporter, inputs, result)
    } finally {
      await lock?.release()
    }
  })
}
