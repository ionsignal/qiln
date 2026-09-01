import { validateHostPreflight, type HostPreflight } from '../checks/host'
import { validateLocalIncus, type IncusPreflight } from '../checks/incus'
import { validateNetworkPreflight, type NetworkPreflight } from '../checks/network'
import { validateStoragePreflight, type StoragePreflight } from '../checks/storage'
import { inspectInstallerState, type InstallerStateInspection } from '../install/state'
import { INSTALLER_SPEC } from '../install/spec'
import type { Reporter } from '../reporter'

export interface DoctorContext {
  host: HostPreflight
  incus: IncusPreflight
  storage: StoragePreflight
  network: NetworkPreflight
  state: InstallerStateInspection
}

export interface DoctorOptions {
  summary?: boolean
}

export async function doctor(reporter: Reporter, options: DoctorOptions = {}): Promise<DoctorContext> {
  reporter.section('Preflight')
  const host = await validateHostPreflight()
  reporter.row(
    'verified',
    'Host',
    `Ubuntu ${host.distributionVersion} · ${host.nodeArchitecture} · kernel ${host.kernelRelease}`,
  )
  reporter.row(
    'verified',
    'Incus package',
    `${host.incusPackageName}=${host.incusPackageVersion} · package metadata is not publisher provenance evidence`,
  )
  const state = await inspectInstallerState()
  reporter.row(
    'verified',
    'Installer state',
    state.exists
      ? 'existing installer state has restrictive ownership and permissions'
      : 'state path is absent and was not created',
  )
  const incus = await validateLocalIncus()
  reporter.row(
    'verified',
    'Incus',
    `local ${incus.server.environment.serverVersion} Unix-socket access · x86_64 supported`,
  )
  const storage = await validateStoragePreflight(host, incus.client)
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
      : `volume '${INSTALLER_SPEC.storage.volumeName}' is absent and was not created`,
  )
  const network = await validateNetworkPreflight(host, incus.client)
  reporter.row(
    'verified',
    'Network',
    network.disposition === 'existing-compatible'
      ? `existing managed network '${INSTALLER_SPEC.network.name}' is compatible`
      : `managed network '${INSTALLER_SPEC.network.name}' is absent and ${INSTALLER_SPEC.network.ipv4Subnet} is available`,
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
  }
}
