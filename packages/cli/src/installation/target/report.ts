import type { Reporter } from '../../terminal/reporter'
import type { Layout } from '../layout'
import type { NetworkPreflight } from '../preflight/network'
import type { IncusStoragePreflight } from '../preflight/storage'

/**
 * The rows of the storage check shared by every target. `hostNote` carries what
 * only a local target observes, such as the host pool health.
 */
export function reportStorage(
  reporter: Reporter,
  layout: Layout,
  storage: IncusStoragePreflight,
  hostNote = '',
): void {
  reporter.row('verified', 'Storage pool', `${storage.incusPool.name} is compatible${hostNote}`)
  reporter.row(
    'verified',
    'PostgreSQL volume',
    storage.existingPostgresVolume
      ? `existing volume '${storage.existingPostgresVolume.name}' is compatible`
      : `volume '${layout.postgres.volumeName}' is absent and was not created`,
  )
}

export function reportNetwork(reporter: Reporter, layout: Layout, network: NetworkPreflight): void {
  reporter.row(
    'verified',
    'Network',
    network.disposition === 'existing-compatible'
      ? `existing managed network '${layout.network.name}' is compatible`
      : `managed network '${layout.network.name}' is absent and ${layout.network.ipv4Subnet} is available`,
  )
}
