const INCUS_BRIDGE_CONFIG = Object.freeze({
  'ipv4.address': '10.10.10.1/24',
  'ipv4.dhcp.ranges': '10.10.10.100-10.10.10.200',
  'ipv4.nat': 'true',
  'ipv6.address': 'none',
  'ipv6.nat': 'false',
} as const)

const POSTGRES_VOLUME_CONFIG = Object.freeze({
  size: '50GiB',
  'initial.uid': '0',
  'initial.gid': '0',
  'initial.mode': '0755',
} as const)

const CREDENTIAL_FILES = Object.freeze({
  authorizedKeys: 'authorized_keys',
  nats: 'nats-server.conf',
  host: 'qiln-host.env',
  gatewayKey: 'qiln-ssh-gateway-host-key',
} as const)

const CREDENTIAL_LIMITS = Object.freeze({
  authorizedKeys: 1 * 1_024 * 1_024,
  nats: 64 * 1_024,
  host: 64 * 1_024,
  gatewayKey: 64 * 1_024,
} as const)

const CREDENTIAL_SUFFIXES = Object.freeze({
  nats: 'nats-server.conf',
  host: 'qiln-host.env',
  authorizedKeys: 'qiln-orchestrator-authorized-keys',
  gatewayKey: 'qiln-ssh-gateway-host-key',
} as const)

const CREDENTIAL_PREFIXES = Object.freeze({
  text: 'systemd.credential.',
  binary: 'systemd.credential-binary.',
} as const)

const INSTANCE_CREDENTIAL_KEYS = Object.freeze({
  nats: `${CREDENTIAL_PREFIXES.text}${CREDENTIAL_SUFFIXES.nats}`,
  host: `${CREDENTIAL_PREFIXES.text}${CREDENTIAL_SUFFIXES.host}`,
  authorizedKeys: `${CREDENTIAL_PREFIXES.text}${CREDENTIAL_SUFFIXES.authorizedKeys}`,
  gatewayKey: `${CREDENTIAL_PREFIXES.binary}${CREDENTIAL_SUFFIXES.gatewayKey}`,
} as const)

const INSTANCE_CREDENTIAL_KEY_LIST = Object.freeze([
  INSTANCE_CREDENTIAL_KEYS.nats,
  INSTANCE_CREDENTIAL_KEYS.host,
  INSTANCE_CREDENTIAL_KEYS.authorizedKeys,
  INSTANCE_CREDENTIAL_KEYS.gatewayKey,
] as const)

const MANAGED_CREDENTIAL_SUFFIXES = Object.freeze([
  CREDENTIAL_SUFFIXES.nats,
  CREDENTIAL_SUFFIXES.host,
  CREDENTIAL_SUFFIXES.authorizedKeys,
  CREDENTIAL_SUFFIXES.gatewayKey,
] as const)

const ORCHESTRATOR_CONFIG = Object.freeze({
  'limits.cpu': '8',
  'limits.memory': '16GiB',
  'limits.processes': '8192',
  'security.idmap.isolated': 'true',
  'security.nesting': 'false',
  'security.privileged': 'false',
} as const)

const ORCHESTRATOR_DEVICES = Object.freeze({
  root: Object.freeze({
    type: 'disk',
    pool: 'is-nvme-pool',
    path: '/',
  }),
  eth0: Object.freeze({
    type: 'nic',
    name: 'eth0',
    network: 'incusbr0',
    'ipv4.address': '10.10.10.10',
    'security.ipv4_filtering': 'true',
    'security.mac_filtering': 'true',
  }),
  'postgres-data': Object.freeze({
    type: 'disk',
    pool: 'is-nvme-pool',
    source: 'qiln-orchestrator-dev-postgres',
    path: '/var/lib/postgresql',
  }),
  incus: Object.freeze({
    type: 'proxy',
    bind: 'instance',
    listen: 'unix:/run/qiln-incus.sock',
    connect: 'unix:/var/lib/incus/unix.socket',
    uid: '1000',
    gid: '1000',
    mode: '0600',
  }),
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
    volumeSize: POSTGRES_VOLUME_CONFIG.size,
    volumeDescription: 'Persistent PostgreSQL 18 data for qiln-orchestrator-dev',
    volumeConfig: POSTGRES_VOLUME_CONFIG,
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
    architecture: 'x86_64',
    type: 'container' as const,
    description: '',
    start: false as const,
    ephemeral: false,
    stateful: false,
    profileNames: [] as const,
    config: ORCHESTRATOR_CONFIG,
    devices: ORCHESTRATOR_DEVICES,
    credentialKeys: INSTANCE_CREDENTIAL_KEY_LIST,
    ipv4Address: ORCHESTRATOR_DEVICES.eth0['ipv4.address'],
    sourceDeviceName: 'source',
    sourceMountPath: '/opt/qiln',
  },
  credentials: {
    files: CREDENTIAL_FILES,
    limits: CREDENTIAL_LIMITS,
    suffixes: CREDENTIAL_SUFFIXES,
    managedSuffixes: MANAGED_CREDENTIAL_SUFFIXES,
    prefixes: CREDENTIAL_PREFIXES,
    keys: INSTANCE_CREDENTIAL_KEYS,
    keyList: INSTANCE_CREDENTIAL_KEY_LIST,
    secretBytes: 32,
    secretEncoding: 'hex' as const,
    gatewayAlgorithm: 'ssh-ed25519',
    gatewayComment: 'qiln-orchestrator-dev-gateway',
    nats: {
      serverName: 'qiln-orchestrator-dev',
      host: '127.0.0.1',
      port: 4222,
    },
  },
  image: {
    metadataMaximumBytes: 1 * 1_024 * 1_024 * 1_024,
    rootfsMaximumBytes: 20 * 1_024 * 1_024 * 1_024,
    metadataStageName: 'incus.tar.xz',
    rootfsStageName: 'rootfs.squashfs',
  },
  incus: {
    socketPath: '/var/lib/incus/unix.socket',
    requestTimeoutMs: 15_000,
    uploadTimeoutMs: 30 * 60 * 1_000,
    operationWaitTimeoutMs: 60 * 60 * 1_000,
    maximumResponseBytes: 4 * 1_024 * 1_024,
    requiredExtensions: ['operation_wait', 'instance_systemd_credentials', 'container_disk_shift'] as const,
  },
  state: {
    installationFileName: 'installation.json',
    authorizedKeysFileName: CREDENTIAL_FILES.authorizedKeys,
    lockFileName: 'installer.lock',
  },
})
