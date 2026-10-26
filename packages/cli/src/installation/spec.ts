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

/**
 * Settings shared by every layout. Resource limits belong to the layout.
 */
const ORCHESTRATOR_CONFIG = Object.freeze({
  'security.idmap.isolated': 'true',
  'security.nesting': 'false',
  'security.privileged': 'false',
  // Resolute's stacked peer labels can fall outside Incus's generated allowances.
  // Permit only the observed same-container signal/send and ptrace/read operations.
  // This preserves generated confinement; it does not address rsyslogd's denials.
  // Validated on a standard Resolute probe; Qiln-image verification remains pending.
  // TODO(apparmor-resolute): Reassess Ubuntu, AppArmor, and Incus/LXC updates in
  // December 2026. Remove only after otherwise identical disposable standard and
  // Qiln Resolute probes boot normally without these rules, remaining unprivileged,
  // non-nested, and isolated-ID-mapped.
  'raw.apparmor': [
    'signal (send) peer=@{profile_name}//&unconfined,',
    'ptrace (read) peer=@{profile_name}//&unconfined,',
  ].join('\n'),
} as const)

const INCUS_PROXY_DEVICE = Object.freeze({
  type: 'proxy',
  bind: 'instance',
  listen: 'unix:/run/qiln-incus.sock',
  connect: 'unix:/var/lib/incus/unix.socket',
  uid: '1000',
  gid: '1000',
  mode: '0600',
} as const)

export const INSTALLER_SPEC = Object.freeze({
  stateVersion: 1,
  evidenceVersion: 1,
  projectName: 'default',
  supportedHost: {
    distributionId: 'ubuntu',
    versionId: '26.04',
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
      name: 'zfs',
      packageName: 'zfsutils-linux',
    },
    {
      name: 'zpool',
      packageName: 'zfsutils-linux',
    },
  ] as const,
  storage: {
    driver: 'zfs',
    volumeType: 'custom',
    volumeContentType: 'filesystem',
    volumeDescription: 'Persistent PostgreSQL 18 data for qiln-orchestrator-dev',
    guestMountPath: '/var/lib/postgresql',
  },
  network: {
    type: 'bridge',
    description: '',
  },
  orchestrator: {
    name: 'qiln-orchestrator-dev',
    imageAlias: 'qiln-orchestrator-dev',
    type: 'container' as const,
    description: '',
    start: false as const,
    ephemeral: false,
    stateful: false,
    profileNames: [] as const,
    config: ORCHESTRATOR_CONFIG,
    incusDevice: INCUS_PROXY_DEVICE,
    credentialKeys: INSTANCE_CREDENTIAL_KEY_LIST,
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
    directory: 'installations',
    registryLockFileName: 'registry.lock',
    installationFileName: 'installation.json',
    configureFileName: 'configure.json',
    lockFileName: 'installation.lock',
    localName: 'dev',
  },
  limits: {
    evidence: 131_072,
  },
})
