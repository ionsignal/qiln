import { INSTALLER_SPEC } from '../../installation/spec'
import { INSTALL_STEPS } from './steps'
import { withInspection } from './inspect'
import { approvalLabel, reportPlan } from './plan'
import { domainApproval, domainProgress, reportAcquisition, reportDomain } from './domain'
import { approve } from '../../terminal/approval'
import { Prompts } from '../../terminal/prompts'
import { acquire } from '../../installation/domain/acquire'
import { rootOf } from '../../installation/checkout/judge'
import { requireIncusExtensions } from '../../installation/preflight/incus'
import { readRoster, validateRoster } from '../../installation/roster'
import { isEmpty, type InstallAction } from '../../installation/journal/types'
import { acquireInstallationLock, loadInstallation, registerInstallation } from '../../installation/state'
import { Configurer, type ConfigureProgress } from '../../installation/configure'
import { withImageSource, type InstallerImageSelection } from '../../installation/image'
import { inputsOf } from '../../installation/types'
import type { FileSnapshot } from '../../state/files'
import type { InstallerLock } from '../../state/lock'
import type { LiveRow, Outcome, Reporter } from '../../terminal/reporter'
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

const OUTCOMES: Record<InstallAction, Outcome> = {
  'materialize-checkout': 'created',
  'delete-image': 'verified',
  'import-image': 'imported',
  'create-alias': 'created',
  'create-network': 'created',
  'create-volume': 'created',
  'create-instance': 'created',
  'update-instance': 'transferred',
}

const VERIFIED_DETAIL = 'fresh observation agrees'

/**
 * `working` starts a live row and `verified` finishes it, so a row is only
 * permanent once the observation and its persistence succeeded. A failure
 * leaves the live row to the diagnostic, which clears it.
 */
function progressSink(reporter: Reporter): (event: ConfigureProgress) => void {
  let live: LiveRow | null = null
  return ({ phase, action }) => {
    const { short, label } = INSTALL_STEPS[action]
    if (phase === 'working') {
      live = reporter.live(short, label)
      return
    }
    if (live === null) {
      reporter.row(OUTCOMES[action], short, VERIFIED_DETAIL)
    } else {
      live.finish(OUTCOMES[action], VERIFIED_DETAIL)
    }
    live = null
  }
}

/**
 * Observes the target first. Once the image source is staged and the
 * configurer is open, the plan is derived a single time, so every refusal that
 * local and Incus state already determine comes before any external effect. A
 * target that owns a public name then acquires its domain and certificate under
 * its own approval, before Incus is changed. The installation plan is displayed
 * next and applied only after an explicit approval. A plan that replaces the
 * managed image is approved in two gates. Registration, locking and
 * image-source handling are shared by every target. Cancellation is owned by
 * the target.
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
    const inputs = inputsOf(host, sourceRoot)
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
        'pending',
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
      const prompts = new Prompts(signal, retry.configure, reporter)
      const { domain } = host
      const { plan } = await withImageSource(options.image, async imageSource => {
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
            show: (gate, held) => reportPlan(reporter, { plan: gate, held, inputs, source: imageSource }),
            approve: (gate, held) => approve(prompts, reporter, approvalLabel(gate, held)),
            progress: progressSink(reporter),
          },
          retry,
        })
        if (domain !== null) {
          await configurer.check()
          reportDomain(
            reporter,
            await acquire({
              directory,
              name: target.name,
              access: domain,
              retry: retry.configure,
              signal,
              hooks: {
                show: acquisition => reportAcquisition(reporter, { plan: acquisition, name: target.name, access: domain }),
                approve: acquisition => approve(prompts, reporter, domainApproval(acquisition)),
                progress: domainProgress(reporter),
              },
            }),
          )
        }
        return await configurer.run(signal)
      })
      reporter.section('Result')
      reporter.row(
        'verified',
        'Final state',
        `${INSTALLER_SPEC.orchestrator.name} · configured · stopped · image ${plan.fingerprint.slice(0, 12)} · ${VERIFIED_DETAIL}`,
      )
      reporter.summary(
        isEmpty(plan)
          ? 'Qiln installation already matched its configuration and is stopped.'
          : 'Qiln installation configured and stopped.',
      )
    } finally {
      await lock?.release()
    }
  })
}
