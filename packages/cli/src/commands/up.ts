import { INSTALLER_SPEC } from '../install/spec'

import { Configurer, type ConfigureResult } from '../install/configure'
import { readRoster, validateRoster } from '../install/roster'
import { withImageSource, type InstallerImageSelection } from '../install/image'
import { isEmpty } from '../install/journal/types'
import { localBinding } from '../install/records'
import { acquireInstallationLock, loadInstallation, registerInstallation } from '../install/state'
import { doctor } from './doctor'
import { approvalLabel, reportPlan } from './installation/plan'
import { InstallerError } from '../diagnostic/error'
import { validateSourcePreflight } from '../checks/source'
import { Prompts, withCancellation } from '../terminal/prompts'
import type { InstallationInputs } from '../install/types'
import type { FileSnapshot } from '../state/files'
import type { InstallerLock } from '../state/lock'
import type { Reporter } from '../terminal/reporter'

const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

export interface UpCommandOptions {
  sourcePath: string
  image: InstallerImageSelection
  authorizedKeysPath?: string
}

function requireIncusExtensions(extensions: readonly string[]): void {
  const missing = INSTALLER_SPEC.incus.requiredExtensions.filter(extension => !extensions.includes(extension))
  if (missing.length === 0) {
    return
  }
  throw new InstallerError({
    code: 'INCUS_CAPABILITY_MISSING',
    facts: [['Missing extensions', missing.join(', ')]],
    retry: 'qiln doctor',
  })
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

export async function up(options: UpCommandOptions, reporter: Reporter): Promise<void> {
  const preflight = await doctor(reporter, {
    summary: false,
  })

  requireIncusExtensions(preflight.incus.server.apiExtensions)

  const source = await validateSourcePreflight(options.sourcePath, preflight.host.commandPaths.git)
  const inputs: InstallationInputs = {
    architecture: preflight.host.architecture,
    layout: preflight.layout,
    sourceRoot: source.sourceRoot,
  }
  let roster: FileSnapshot | null = null
  if (options.authorizedKeysPath !== undefined) {
    roster = await validateRoster(
      await readRoster(options.authorizedKeysPath),
      preflight.host.commandPaths['ssh-keygen'],
    )
  }
  reporter.row('verified', 'Source', `validated Git checkout '${source.sourceRoot}'`)
  if (roster !== null) {
    reporter.row('verified', 'Authorized keys', `validated stable roster · ${roster.size} bytes`)
  }
  const name = INSTALLER_SPEC.state.localName
  const binding = await localBinding()
  const directory = await registerInstallation(name, binding, inputs)
  let lock: InstallerLock | undefined
  try {
    lock = await acquireInstallationLock(directory)
    const installation = await loadInstallation(directory, binding, inputs)
    const result = await withCancellation(signal =>
      withImageSource(options.image, async imageSource => {
        const prompts = new Prompts(signal, RERUN, reporter)
        const configurer = await Configurer.open({
          directory,
          installation,
          client: preflight.incus.client,
          inputs,
          source: imageSource,
          sshKeygen: preflight.host.commandPaths['ssh-keygen'],
          roster,
          hooks: {
            show: plan => reportPlan(reporter, { plan, inputs, source: imageSource }),
            approve: plan => prompts.approve(approvalLabel(plan)),
          },
        })
        return await configurer.run(signal)
      }),
    )
    reportResult(reporter, inputs, result)
  } finally {
    await lock?.release()
  }
}
