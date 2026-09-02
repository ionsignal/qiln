import { QilnInstallerError } from '../error'
import { convergeImage, type InstallerImageSelection } from '../install/image'
import { convergeInstance } from '../install/instance'
import { acquireInstallerLock } from '../install/lock'
import { convergeNetwork } from '../install/network'
import { convergeStorage } from '../install/storage'
import { convergeCredentials } from '../install/credentials'
import {
  inspectOpenInstallerState,
  openInstallerState,
  readRoster,
  validateRoster,
  writeInstallationState,
} from '../install/state'
import { INSTALLER_SPEC } from '../install/spec'
import { validateSourcePreflight } from '../checks/source'
import { doctor } from './doctor'
import type { FileSnapshot } from '../install/files'
import type { Reporter } from '../reporter'

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
  throw new QilnInstallerError({
    code: 'INCUS_CAPABILITY_MISSING',
    check: 'required Incus installer capabilities',
    summary: 'The running Incus daemon is missing a required installer capability.',
    observed: `Missing API extensions: ${missing.join(', ')}.`,
    reason:
      'Qiln requires shifted container source disks, guarded systemd credential delivery, and verified terminal operation results before performing installer mutations.',
    operatorAction: 'Install and run a supported Incus 7.x daemon that exposes the required API extensions.',
    rerun: 'qiln doctor',
  })
}

export async function up(options: UpCommandOptions, reporter: Reporter): Promise<void> {
  const preflight = await doctor(reporter, {
    summary: false,
  })
  requireIncusExtensions(preflight.incus.server.apiExtensions)
  const source = await validateSourcePreflight(options.sourcePath, preflight.host.commandPaths.git)
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
  const stateDirectory = await openInstallerState()
  const lock = await acquireInstallerLock(stateDirectory)
  try {
    const currentState = await inspectOpenInstallerState(stateDirectory)
    const image = await convergeImage(preflight.incus.client, options.image, currentState.installation)
    const installation = await writeInstallationState(stateDirectory, image.fingerprint)
    reporter.row(
      image.outcome,
      'Image',
      image.replacement
        ? `${image.fingerprint} · x86_64 container image · explicit development replacement completed`
        : `${image.fingerprint} · x86_64 container image`,
    )
    reporter.row('verified', 'Image pin', `persisted full fingerprint in ${INSTALLER_SPEC.state.installationFileName}`)
    reporter.notice(
      'The operator-selected image is trusted guest code. Qiln has not established provenance, authenticity, guest compatibility, or bootstrap readiness.',
    )
    if (image.replacement) {
      reporter.notice(
        'The explicit split-image path deleted the previous managed alias target before convergence. Other aliases attached to that image may also have been removed, and no automatic rollback was attempted.',
      )
    }
    const network = await convergeNetwork(preflight.incus.client)
    reporter.row(
      network.outcome,
      'Network',
      `${network.network.name} · ${INSTALLER_SPEC.network.ipv4Subnet} · managed bridge`,
    )
    const storage = await convergeStorage(preflight.incus.client)
    reporter.row(
      storage.outcome,
      'PostgreSQL volume',
      `${storage.volume.name} · ${storage.volume.config.size} · persistent custom volume`,
    )
    const instance = await convergeInstance(preflight.incus.client, installation, source.sourceRoot)
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
      directory: stateDirectory,
      client: preflight.incus.client,
      sshKeygen: preflight.host.commandPaths['ssh-keygen'],
      roster,
      verifyAlias: options.image.kind === 'split',
      sourceRoot: source.sourceRoot,
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
    await lock.release()
    await stateDirectory.close()
  }
}
