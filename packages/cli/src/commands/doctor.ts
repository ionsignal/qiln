import { INSTALLER_SPEC } from '../install/spec'
import { validateHostPreflight, type HostPreflight } from '../checks/host'
import { validateLocalIncus, type IncusPreflight } from '../checks/incus'
import { validateNetworkPreflight, type NetworkPreflight } from '../checks/network'
import { validateStoragePreflight, type StoragePreflight } from '../checks/storage'
import { inspectInstallation, type InstallationInspection } from '../install/state'
import { devLayout, type Layout } from '../install/layout'
import { localBinding } from '../install/records'
import type { Reporter } from '../terminal/reporter'

export interface DoctorContext {
  host: HostPreflight
  incus: IncusPreflight
  storage: StoragePreflight
  network: NetworkPreflight
  state: InstallationInspection
  layout: Layout
}

export interface DoctorOptions {
  summary?: boolean
}

export async function doctor(reporter: Reporter, options: DoctorOptions = {}): Promise<DoctorContext> {
  const layout = devLayout
  reporter.section('Preflight')
  const host = await validateHostPreflight()
  reporter.row(
    'verified',
    'Host',
    `Ubuntu ${host.distributionVersion} · ${host.architecture.package} · kernel ${host.kernelRelease}`,
  )
  reporter.row(
    'verified',
    'Incus package',
    `${host.incusPackageName}=${host.incusPackageVersion} · package metadata is not publisher provenance evidence`,
  )
  const name = INSTALLER_SPEC.state.localName
  const state = await inspectInstallation(name, await localBinding())
  reporter.row(
    'verified',
    'Installer state',
    state.record === null
      ? 'no installation is recorded and nothing was created'
      : `installation '${name}' is bound to this host and its state has restrictive ownership and permissions`,
  )
  const incus = await validateLocalIncus(host.architecture)
  reporter.row(
    'verified',
    'Incus',
    `local ${incus.server.environment.serverVersion} Unix-socket access · ${host.architecture.incus} supported`,
  )
  const storage = await validateStoragePreflight(host, incus.client, layout)
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
  const network = await validateNetworkPreflight(host, incus.client, layout)
  reporter.row(
    'verified',
    'Network',
    network.disposition === 'existing-compatible'
      ? `existing managed network '${layout.network.name}' is compatible`
      : `managed network '${layout.network.name}' is absent and ${layout.network.ipv4Subnet} is available`,
  )
  if (options.summary !== false) {
    reporter.summary('Doctor completed without changing host, installer, or Incus state.')
  }
  return {
    host,
    incus,
    storage,
    network,
    state,
    layout,
  }
}
