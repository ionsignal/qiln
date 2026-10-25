import { INSTALLER_SPEC } from '../install/spec'

import { convergeInstance } from '../install/instance'
import { convergeNetwork } from '../install/network'
import { convergeStorage } from '../install/storage'
import { convergeCredentials } from '../install/credentials'
import { localBinding } from '../install/records'
import { readRoster, validateRoster } from '../install/roster'
import { convergeImage, type InstallerImageSelection } from '../install/image'
import {
  acquireInstallationLock,
  loadInstallation,
  pinImage,
  pinned,
  registerInstallation,
} from '../install/state'
import { doctor } from './doctor'
import { InstallerError } from '../diagnostic/error'
import { validateSourcePreflight } from '../checks/source'
import type { InstallationInputs } from '../install/types'
import type { FileSnapshot } from '../state/files'
import type { InstallerLock } from '../state/lock'
import type { Reporter } from '../terminal/reporter'

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
    const current = await loadInstallation(directory, binding, inputs)
    const image = await convergeImage(
      preflight.incus.client,
      options.image,
      pinned(current),
      inputs.architecture,
    )
    const installation = await pinImage(directory, current, image.fingerprint)
    reporter.row(
      image.outcome,
      'Image',
      image.replacement
        ? `${image.fingerprint} · ${inputs.architecture.incus} container image · explicit development replacement completed`
        : `${image.fingerprint} · ${inputs.architecture.incus} container image`,
    )
    reporter.row(
      'verified',
      'Image pin',
      `persisted full fingerprint in ${INSTALLER_SPEC.state.installationFileName} of installation '${name}'`,
    )
    reporter.notice(
      'The operator-selected image is trusted guest code. Qiln has not established provenance, authenticity, guest compatibility, or bootstrap readiness.',
    )
    if (image.replacement) {
      reporter.notice(
        'The explicit split-image path deleted the previous managed alias target before convergence. Other aliases attached to that image may also have been removed, and no automatic rollback was attempted.',
      )
    }
    const network = await convergeNetwork(preflight.incus.client, inputs.layout)
    reporter.row(
      network.outcome,
      'Network',
      `${network.network.name} · ${inputs.layout.network.ipv4Subnet} · managed bridge`,
    )
    const storage = await convergeStorage(preflight.incus.client, inputs.layout)
    reporter.row(
      storage.outcome,
      'PostgreSQL volume',
      `${storage.volume.name} · ${storage.volume.config.size} · persistent custom volume`,
    )
    const instance = await convergeInstance(preflight.incus.client, installation, inputs)
    reporter.row(
      instance.outcome,
      'Orchestrator',
      `${instance.instance.name} · ${instance.instance.architecture} container · ${instance.instance.status}`,
    )
    reporter.row(
      'verified',
      'Source device',
      `${source.sourceRoot} → ${INSTALLER_SPEC.orchestrator.sourceMountPath} · writable shifted disk`,
    )
    const credentials = await convergeCredentials({
      directory,
      client: preflight.incus.client,
      sshKeygen: preflight.host.commandPaths['ssh-keygen'],
      roster,
      verifyAlias: options.image.kind === 'split',
      inputs,
    })
    reporter.row(
      credentials.localOutcome === 'generated'
        ? 'created'
        : credentials.localOutcome === 'roster-updated'
          ? 'transferred'
          : 'reused',
      'Local credentials',
      credentials.localOutcome === 'generated'
        ? 'generated and retained four protected credential files'
        : credentials.localOutcome === 'roster-updated'
          ? 'replaced only the retained authorized-key roster'
          : 'reused the complete retained credential set',
    )
    reporter.row(
      credentials.deliveryOutcome,
      'Instance credentials',
      credentials.deliveryOutcome === 'transferred'
        ? 'delivered four credentials through one guarded complete instance update'
        : 'instance credentials already matched the retained local source of truth',
    )
    reporter.row('verified', 'Image identity', credentials.imageFingerprint)
    reporter.row('verified', 'Final state', `${instance.instance.name} · configured · stopped`)
    reporter.summary('Qiln installation configured and stopped.')
  } finally {
    await lock?.release()
  }
}
