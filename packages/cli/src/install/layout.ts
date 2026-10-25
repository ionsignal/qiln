import type { IncusConfigMap } from '../incus/types'

/**
 * The pool, network, volume, and limits that one installation expects. It
 * carries data only: every other installation setting is fixed in
 * `INSTALLER_SPEC`. A limit that is omitted is not applied.
 */
export interface Layout {
  pool: {
    name: string
  }
  network: {
    name: string
    ipv4Subnet: string
    config: Readonly<IncusConfigMap>
  }
  postgres: {
    volumeName: string
    config: Readonly<IncusConfigMap>
  }
  orchestrator: {
    ipv4Address: string
    limits: Readonly<IncusConfigMap>
  }
}

/**
 * The local development layout.
 */
export const devLayout: Layout = Object.freeze({
  pool: {
    name: 'is-nvme-pool',
  },
  network: {
    name: 'incusbr0',
    ipv4Subnet: '10.10.10.0/24',
    config: {
      'ipv4.address': '10.10.10.1/24',
      'ipv4.dhcp': 'true',
      'ipv4.dhcp.ranges': '10.10.10.100-10.10.10.200',
      'ipv4.firewall': 'false',
      'ipv4.nat': 'true',
      'ipv4.routing': 'true',
      'ipv6.address': 'none',
      'ipv6.firewall': 'false',
      'ipv6.nat': 'false',
    },
  },
  postgres: {
    volumeName: 'qiln-orchestrator-dev-postgres',
    config: {
      size: '50GiB',
      'initial.uid': '0',
      'initial.gid': '0',
      'initial.mode': '0755',
    },
  },
  orchestrator: {
    ipv4Address: '10.10.10.10',
    limits: {
      'limits.cpu': '8',
      'limits.memory': '16GiB',
      'limits.processes': '8192',
    },
  },
})
