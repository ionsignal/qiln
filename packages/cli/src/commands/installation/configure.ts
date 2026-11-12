import { INSTALLER_SPEC } from '../../installation/spec'
import { INSTALL_STEPS } from './steps'
import { withInspection } from './inspect'
import { approvalLabel, describeIngress, reportPlan } from './plan'
import { domainApproval, domainProgress, reportAcquisition, reportDomain } from './domain'
import { stepSink, type StepResult } from './progress'
import { start } from './start'
import { approve } from '../../terminal/approval'
import { Prompts } from '../../terminal/prompts'
import { acquire } from '../../installation/domain/acquire'
import { rootOf } from '../../installation/checkout/judge'
import { loadIngress, type Ingress } from '../../installation/ingress'
import { readRoster, validateRoster } from '../../installation/roster'
import { requireIncusExtensions } from '../../installation/preflight/incus'
import { isEmpty, type InstallAction } from '../../installation/journal/types'
import { Configurer } from '../../installation/configure'
import { withImageSource, type InstallerImageSelection } from '../../installation/image'
import { acquireInstallationLock, loadInstallation, registerInstallation } from '../../installation/state'
import { inputsOf } from '../../installation/types'
import type { FileSnapshot } from '../../state/files'
import type { InstallerLock } from '../../state/lock'
import type { Outcome, Reporter } from '../../terminal/reporter'
import type { InstallationTarget } from '../../installation/target/types'

const VERIFIED_DETAIL = 'fresh observation agrees'

function verified(outcome: Outcome): StepResult {
  return { outcome, detail: VERIFIED_DETAIL }
}

const RESULTS: Record<InstallAction, StepResult> = {
  'materialize-checkout': verified('created'),
  'delete-image': verified('verified'),
  'import-image': verified('imported'),
  'create-alias': verified('created'),
  'create-network': verified('created'),
  'create-volume': verified('created'),
  'create-instance': verified('created'),
  'update-instance': verified('transferred'),
}

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
 * Observes the target first. Once the image source is staged, opening the
 * configurer settles any step that an earlier run left returned and derives a
 * preflight plan. Settling first verifies that step against the ingress it was
 * approved with, before acquisition can replace it, and the preflight surfaces
 * every refusal that local and Incus state already determine before any
 * external effect. A target that owns a public name then acquires its domain and
 * certificate under its own approval, before Incus is changed. The installation
 * plan is derived from a fresh observation, so it delivers what was acquired,
 * and is displayed and applied only after an explicit approval. A plan that
 * replaces the managed image is approved in two gates. Once the stopped
 * installation is verified, startup is offered under its own separate approval,
 * still inside the installation lock. Registration, locking and image-source
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
      const { plan, observation } = await withImageSource(options.image, async imageSource => {
        let ingress: Ingress | null = null
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
            show: (gate, held) => reportPlan(reporter, { plan: gate, held, inputs, source: imageSource, ingress }),
            approve: (gate, held) => approve(prompts, reporter, approvalLabel(gate, held)),
            progress: stepSink(reporter, INSTALL_STEPS, RESULTS),
          },
          retry,
        })
        if (domain !== null) {
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
        ingress = await loadIngress(directory, inputs, retry.configure)
        return await configurer.run(signal)
      })
      const delivered = observation.ingress === null ? '' : ` · ingress configuration ${describeIngress(observation.ingress)}`
      const status = observation.instance?.value.status.toLowerCase() ?? 'absent'
      reporter.section('Result')
      reporter.row(
        'verified',
        'Final state',
        `${INSTALLER_SPEC.orchestrator.name} · configured · ${status} · image ${plan.fingerprint.slice(0, 12)}${delivered} · ${VERIFIED_DETAIL}`,
      )
      const state = await start({
        directory,
        name: target.name,
        client: incus.client,
        retry,
        prompts,
        reporter,
        signal,
        observation,
      })
      if (state === 'running') {
        reporter.summary(
          'Qiln installation configured and running. Guest readiness was verified; public reachability and application correctness were not.',
        )
      } else {
        reporter.summary(
          isEmpty(plan)
            ? `Qiln installation already matched its configuration and is ${status}.`
            : 'Qiln installation configured and stopped.',
        )
      }
    } finally {
      await lock?.release()
    }
  })
}
