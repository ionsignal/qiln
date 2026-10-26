import { INSTALLER_SPEC } from '../spec'
import { validateHostPreflight } from '../preflight/host'
import { validateLocalIncus } from '../preflight/incus'
import { validateNetworkPreflight } from '../preflight/network'
import { validateSourcePreflight } from '../preflight/source'
import { validateStoragePreflight } from '../preflight/storage'
import { devLayout } from '../layout'
import { localBinding } from '../records'
import type { Retry } from '../retry'
import type { InstallationTarget } from './types'

/**
 * This machine: the operator-side host checks, the local Incus socket, and the
 * development layout. `commands` names the workflow that diagnostics tell the
 * operator to run again, and `signal` is the cancellation of the invocation.
 */
export const localTarget = (commands: Retry, signal: AbortSignal): InstallationTarget => ({
  name: INSTALLER_SPEC.state.localName,
  retry: commands,
  signal,
  async withHost(reporter, retry, use) {
    const layout = devLayout
    const preflight = await validateHostPreflight(retry)
    reporter.row(
      'verified',
      'Host',
      `Ubuntu ${preflight.distributionVersion} · ${preflight.architecture.package} · kernel ${preflight.kernelRelease}`,
    )
    reporter.row(
      'verified',
      'Incus package',
      `${preflight.incusPackageName}=${preflight.incusPackageVersion} · package metadata is not publisher provenance evidence`,
    )
    return await use({
      binding: await localBinding(retry),
      architecture: preflight.architecture,
      layout,
      sshKeygen: preflight.commandPaths['ssh-keygen'],
      checkout: async path => (await validateSourcePreflight(path, preflight.commandPaths.git, retry)).sourceRoot,
      withIncus: async useIncus => {
        const incus = await validateLocalIncus(preflight.architecture, retry, signal)
        reporter.row(
          'verified',
          'Incus',
          `local ${incus.server.environment.serverVersion} Unix-socket access · ${preflight.architecture.incus} supported`,
        )
        return await useIncus({
          client: incus.client,
          extensions: incus.server.apiExtensions,
          verifyLayout: async () => {
            const storage = await validateStoragePreflight(preflight, incus.client, layout, retry)
            reporter.row(
              'verified',
              'Storage pool',
              `${storage.incusPool.name} is compatible · host ZFS health is ${storage.hostPoolHealth}`,
            )
            reporter.row(
              'verified',
              'PostgreSQL volume',
              storage.existingPostgresVolume
                ? `existing volume '${storage.existingPostgresVolume.name}' is compatible`
                : `volume '${layout.postgres.volumeName}' is absent and was not created`,
            )
            const network = await validateNetworkPreflight(preflight, incus.client, layout, retry)
            reporter.row(
              'verified',
              'Network',
              network.disposition === 'existing-compatible'
                ? `existing managed network '${layout.network.name}' is compatible`
                : `managed network '${layout.network.name}' is absent and ${layout.network.ipv4Subnet} is available`,
            )
          },
        })
      },
    })
  },
})
