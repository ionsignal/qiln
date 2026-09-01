const INCUS_BRIDGE_CONFIG = Object.freeze({
  'ipv4.address': '10.10.10.1/24',
  'ipv4.dhcp.ranges': '10.10.10.100-10.10.10.200',
  'ipv4.nat': 'true',
  'ipv6.address': 'none',
  'ipv6.nat': 'false',
} as const)

export const INSTALLER_SPEC = Object.freeze({
  stateVersion: 1,
  projectName: 'default',
  supportedHost: {
    distributionId: 'ubuntu',
    versionId: '24.04',
    nodeArchitecture: 'x64',
    incusArchitecture: 'x86_64',
    minimumKernelRelease: '6.8.0-138-generic',
    minimumIncusVersion: '7.0',
    maximumIncusVersionExclusive: '8.0',
  },
  tools: [
    {
      name: 'dpkg',
      packageName: 'dpkg',
    },
    {
      name: 'dpkg-query',
      packageName: 'dpkg',
    },
    {
      name: 'git',
      packageName: 'git',
    },
    {
      name: 'ip',
      packageName: 'iproute2',
    },
    {
      name: 'ssh-keygen',
      packageName: 'openssh-client',
    },
    {
      name: 'tar',
      packageName: 'tar',
    },
    {
      name: 'zfs',
      packageName: 'zfsutils-linux',
    },
    {
      name: 'zpool',
      packageName: 'zfsutils-linux',
    },
  ] as const,
  storage: {
    poolName: 'is-nvme-pool',
    driver: 'zfs',
    volumeName: 'qiln-orchestrator-dev-postgres',
    volumeType: 'custom',
    volumeContentType: 'filesystem',
    volumeSize: '50GiB',
    volumeDescription: 'Persistent PostgreSQL 18 data for qiln-orchestrator-dev',
    guestMountPath: '/var/lib/postgresql',
  },
  network: {
    name: 'incusbr0',
    type: 'bridge',
    description: '',
    config: INCUS_BRIDGE_CONFIG,
    ipv4Subnet: '10.10.10.0/24',
    ipv4DhcpRange: INCUS_BRIDGE_CONFIG['ipv4.dhcp.ranges'],
  },
  orchestrator: {
    name: 'qiln-orchestrator-dev',
    imageAlias: 'qiln-orchestrator-dev',
    profileNames: ['qiln-default', 'qiln-orchestrator-dev'] as const,
    ipv4Address: '10.10.10.10',
  },
  incus: {
    socketPath: '/var/lib/incus/unix.socket',
    requestTimeoutMs: 15_000,
    maximumResponseBytes: 4 * 1_024 * 1_024,
  },
  state: {
    installationFileName: 'installation.json',
    authorizedKeysFileName: 'authorized_keys',
  },
})
