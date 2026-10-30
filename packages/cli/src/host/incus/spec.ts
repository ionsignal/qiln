interface RunSpec {
  script:
    | 'close'
    | 'guard'
    | 'repository'
    | 'refresh'
    | 'packages'
    | 'init'
    | 'open'
    | 'access'
    | 'workloads'
    | 'release'
  timeoutMs: number
  refusals: Readonly<Record<number, string>>
}

interface StepSpec {
  storage: boolean
  run: RunSpec
}

/**
 * The one enumeration of Incus preparation steps. `storage` marks the steps
 * that can leave Incus data on the pool or its outcome unknown, and only those
 * block removal and volume handoff. A step names one embedded script, its
 * deadline, and the wording of every exit code that script uses to refuse
 * before any effect. Arguments are built from the approved plan by `apply.ts`.
 */
const STEPS = {
  close: {
    storage: false,
    run: {
      script: 'close',
      timeoutMs: 60_000,
      refusals: {
        20: 'The sysctl override path, contents, or digest, or an Incus unit name, was not given or is malformed.',
        21: 'An Incus unit is already active, and Qiln does not stop or adopt a running daemon.',
        22: 'An existing sysctl override is not a regular file holding exactly the approved bytes.',
        23: 'The sysctl override could not be staged beside its destination.',
        24: 'The sysctl override does not match its approved SHA-256 digest.',
      },
    },
  },
  guard: {
    storage: false,
    run: {
      script: 'guard',
      timeoutMs: 60_000,
      refusals: {
        20: 'The guard file paths, contents, or digests were not given or are malformed.',
        21: 'The private staging directory for the guard files could not be created.',
        22: 'A guard file does not match its approved SHA-256 digest.',
        23: 'An existing guard file is not a regular file holding exactly the approved bytes.',
      },
    },
  },
  'add-repository': {
    storage: false,
    run: {
      script: 'repository',
      timeoutMs: 60_000,
      refusals: {
        20: 'The repository or preferences file paths, key URL, contents, or digests were not given or are malformed.',
        21: 'An APT keyring, source, or preferences directory does not exist, or a file could not be staged.',
        22: 'The source or preferences bytes do not match their approved SHA-256 digest.',
        23: 'An existing repository or preferences file is not a regular file holding exactly the approved bytes.',
        24: 'The guest has no curl, and Qiln does not install prerequisites.',
        25: 'The signing key could not be downloaded from the approved URL.',
        26: 'The downloaded signing key does not match its approved SHA-256 digest.',
      },
    },
  },
  'refresh-lists': {
    storage: false,
    run: {
      script: 'refresh',
      timeoutMs: 300_000,
      refusals: {
        20: 'The source file path was not given or is not absolute.',
        21: 'The approved repository source file does not exist.',
      },
    },
  },
  'install-packages': {
    storage: false,
    run: {
      script: 'packages',
      timeoutMs: 600_000,
      refusals: {
        20: 'No packages were given to install.',
        21: 'APT could not resolve the approved packages from its current package lists.',
        22: 'APT no longer plans exactly the approved package names and versions.',
        23: 'APT would now upgrade or remove other packages.',
        24: 'APT would now configure a package that is not among the approved installations.',
      },
    },
  },
  open: {
    storage: true,
    run: {
      script: 'open',
      timeoutMs: 120_000,
      refusals: {
        20: 'The open mode, the startup check, its digest, the expectation file, the state directory, the minimum allocation, the retained metadata entries, the recorded ID ranges, or the unit names were not given or are malformed.',
        21: 'The installed startup check is not an executable regular file.',
        22: 'The installed startup check does not match its approved SHA-256 digest.',
        23: 'The startup check refused: the state directory is not the recorded state dataset of the recorded pool.',
        24: 'The state directory is not empty, so a fresh open is refused, and Qiln never opens retained Incus state as a fresh installation.',
        25: 'The state directory does not hold the retained Incus metadata that a preserved open requires, and Qiln never falls back to a fresh installation.',
        26: 'The state directory could not be listed.',
        27: 'A subordinate-ID file lists no root range of the minimum size that a fresh open requires, and Qiln never edits it.',
        28: 'A subordinate-ID file does not list a root range recorded with the preserved installation, and Qiln never edits it.',
      },
    },
  },
  initialize: {
    storage: true,
    run: {
      script: 'init',
      timeoutMs: 300_000,
      refusals: {
        20: 'The preseed, its digest, the recorded pool name, GUID, or dataset identities, the state directory, or the bridge name or subnet was not given or is malformed.',
        21: 'The Incus client was not found.',
        22: 'The preseed does not match its approved SHA-256 digest.',
        23: 'The Incus daemon socket is not active, and Qiln does not start it.',
        24: 'A storage pool already exists, so this is not a fresh initialization.',
        25: 'An instance already exists, so this is not a fresh initialization.',
        26: 'The preseed could not be staged.',
        27: 'The Incus API or a host listing could not be read before initialization.',
        28: 'The recorded ZFS pool is not imported with the approved GUID.',
        29: 'The Incus server already has configuration, so this is not a fresh initialization.',
        30: 'The Incus server does not advertise the storage_zfs_export API extension.',
        31: 'Incus has projects or profiles beyond the pristine default, or the default profile has devices.',
        32: 'A managed Incus network, or a network interface with the approved bridge name, already exists.',
        33: 'Incus already holds images, so this is not a fresh initialization.',
        34: 'The Incus daemon is listening on a TCP address.',
        35: 'The recorded ZFS pool does not hold exactly its root, its state dataset, and its storage dataset, so it does not look fresh.',
        36: 'A host route overlaps the approved bridge subnet.',
        37: 'A recorded dataset does not have its approved GUID.',
        38: 'The recorded state dataset is not the filesystem mounted at the state directory.',
        39: 'A dataset other than the state dataset is mounted.',
      },
    },
  },
  'grant-access': {
    storage: false,
    run: {
      script: 'access',
      timeoutMs: 30_000,
      refusals: {
        20: 'The account or group name was not given or is malformed.',
        21: 'The Incus administration group does not exist on the host, and Qiln does not create groups.',
        22: 'The administrator account does not exist on the host.',
        23: 'The account is root, which never receives a group grant.',
      },
    },
  },
  'stop-workloads': {
    storage: true,
    run: {
      script: 'workloads',
      // The SSH layer caps one command at ten minutes, which bounds the graceful stops.
      timeoutMs: 600_000,
      refusals: {
        20: 'The stop timeout or an instance reference was not given or is malformed.',
        21: 'The Incus client could not be prepared.',
        22: 'The Incus daemon service is not running, so its instances cannot be enumerated, and Qiln does not start it.',
        23: 'The Incus instances could not be listed.',
        24: 'The Incus instances no longer match the approved inventory.',
        25: 'An approved instance could not be read.',
        26: 'An approved instance is ephemeral, and stopping it would delete it.',
      },
    },
  },
  release: {
    storage: true,
    run: {
      script: 'release',
      // The SSH layer caps one command at ten minutes, which bounds orderly instance shutdown.
      timeoutMs: 600_000,
      refusals: {
        20: 'The Incus unit names were not given or are malformed.',
        21: 'The packaged Incus daemon unit was not found.',
        22: 'The Incus client could not be prepared.',
      },
    },
  },
} as const satisfies Record<string, StepSpec>

/**
 * The packages that a replacement host must install at exactly their recorded
 * version to reopen a preserved installation. The LXC runtime, liblxc, and the
 * helper binaries are bundled under /opt/incus inside incus-base, and neither
 * incus-base nor incus-client depends on an lxc, liblxc, or uidmap package, so
 * none is pinned here: the exact incus pins identify the bundled runtime.
 */
const PINNED = ['incus*'] as const

/**
 * Reviewed coordinates and fixed limits of the Incus preparation recipe.
 *
 * - `packages` are simulated and installed, `companions` must arrive with them,
 *   and `excluded` packages are refused if present. The scope is containers
 *   only: `incus` is the VM-capable meta-package, and VM support is out of
 *   scope.
 * - `packageVersions` selects the full version of both required packages for
 *   each native architecture. These are selected pins, not evidence that the
 *   artifacts were exercised. APT metadata and simulation must confirm the
 *   exact names, versions, architecture, and availability before installation.
 * - The `stable` channel is moving, not a version pin. The preferences file
 *   selects these exact builds and excludes other versions from normal APT
 *   selection. Future Incus updates require deliberate repinning.
 * - The signing key is downloaded on the host from `keyUrl` and must match
 *   `keySha256`, the SHA-256 of the raw file bytes. A rotated or re-issued key
 *   fails closed and needs a new reviewed constant. `fingerprint` is review
 *   metadata only, because the host verifies the file digest and not the
 *   OpenPGP fingerprint.
 * - `units` are the Incus activation paths. Closing and release mask all of
 *   them persistently, and their positive inactivity establishes quiescence.
 *   They must match the units reported by the inspection script.
 *   `incus-lxcfs.service` is deliberately absent: the packaged daemon unit
 *   requires it, and it mounts only its own FUSE filesystem and does not use the
 *   state directory. The package scripts therefore enable and start it when they
 *   install. `incus-startup.service` stays masked, so the host does not
 *   stop instances at shutdown, and release is the designed stop path.
 *   `open.units` are the only ones that the open step unmasks and starts, so the
 *   user and startup units stay masked.
 * - `sysctl` is the Qiln-owned override that the close step installs. The
 *   package ships `/usr/lib/sysctl.d/50-incus.conf`, which sets this key to 0
 *   and which the package script applies by restarting systemd-sysctl. The
 *   `99-` name sorts after it, so the override wins at that restart. The other
 *   sysctls of the package are accepted and disclosed.
 * - `guard` names the three root-owned files that protect the state directory:
 *   the expectation file with the recorded pool and state dataset identities,
 *   the startup check that compares them with the kernel mount table, and the
 *   drop-in that runs that check before the daemon service starts.
 * - `requiredExtensions` gate the `zfs.export` pool key, which keeps the Incus
 *   driver from exporting the whole pool when it unmounts.
 * - `access.group` is the Incus administration group. Membership is
 *   root-equivalent authority over the Incus Unix socket, and Qiln only ever
 *   adds the administrator account to it.
 * - `idmap.minimum` is the size of the root range that a fresh open requires in
 *   each of `/etc/subuid` and `/etc/subgid`.
 * - `release` bounds the workload stop. Each running instance gets
 *   `stopTimeoutSeconds` to shut down cleanly, and `maximumRunning` of them
 *   fit the SSH command ceiling together with the autostart updates.
 *   `maximumInstances` bounds the frozen inventory that the evidence retains.
 * - `floors` are the upstream Incus v7.0.0 prerequisites, compared by their
 *   leading dotted number only. The kernel floor is judged on the host. The LXC
 *   floor is judged on the version the running daemon reports, because an
 *   offline probe does not describe the bundled runtime. They are provisional
 *   until the audit of the selected packages confirms them.
 * - `software.patterns` are the `dpkg-query` globs of the packages that make up
 *   the recorded software baseline: Incus and ZFS. `software.pinned` is the
 *   Incus subset that a preserved open requires at exactly the recorded
 *   version, and ZFS is judged by the floors. Both are provisional until that
 *   same audit.
 * - `retained.metadata` are the entries, relative to the state directory, that
 *   a preserved open requires to be present before the daemon may start. They
 *   are provisional until the audit of the selected packages confirms them.
 * - `maximumInstalls` bounds the resolved transaction, not an expected count.
 */
export const INCUS_SPEC = Object.freeze({
  recipeRevision: 2,
  maximumInstalls: 64,
  packages: ['incus-base'],
  companions: ['incus-client'],
  packageVersions: {
    amd64: '1:7.5.1-ubuntu26.04-202610262256',
    arm64: '1:7.5.1-ubuntu26.04-202610262324',
  },
  excluded: ['incus', 'incus-ui-canonical', 'incus-extra'],
  units: ['incus.socket', 'incus.service', 'incus-user.socket', 'incus-user.service', 'incus-startup.service'],
  open: {
    units: ['incus.socket', 'incus.service'],
  },
  sysctl: {
    file: '/etc/sysctl.d/99-qiln-incus.conf',
    key: 'kernel.apparmor_restrict_unprivileged_unconfined',
    value: '1',
  },
  guard: {
    expectationFile: '/etc/qiln/incus-state.expect',
    checkFile: '/usr/local/lib/qiln/incus-start-check',
    dropInFile: '/etc/systemd/system/incus.service.d/qiln-guard.conf',
  },
  requiredExtensions: ['storage_zfs_export'],
  idmap: {
    minimum: 65_536,
  },
  release: {
    stopTimeoutSeconds: 30,
    maximumRunning: 15,
    maximumInstances: 256,
  },
  floors: {
    kernel: '6.12',
    lxc: '6.0.0',
    zfs: '2.1.0',
  },
  software: {
    pinned: PINNED,
    patterns: [...PINNED, 'zfsutils-linux', 'zfs-*', 'libzfs*'],
  },
  retained: {
    metadata: ['database/local.db', 'database/global', 'server.crt', 'server.key'],
  },
  repository: {
    uri: 'https://pkgs.zabbly.com/incus/stable',
    suite: 'resolute',
    component: 'main',
    fingerprint: '4EFC590696CB15B87C73A3AD82CC8797C838DCFD',
    keyUrl: 'https://pkgs.zabbly.com/key.asc',
    keySha256: 'f1adb44fdf82083f983a392b5b406d34e473dce3d66a51de3118cdc1f51d3f87',
    keyFile: '/etc/apt/keyrings/zabbly.asc',
    sourceFile: '/etc/apt/sources.list.d/zabbly-incus-stable.sources',
    preferencesFile: '/etc/apt/preferences.d/qiln-incus',
  },
  network: {
    name: 'incusbr0',
    address: '10.10.10.1/24',
    subnet: '10.10.10.0/24',
    dhcpRange: '10.10.10.100-10.10.10.200',
  },
  access: {
    group: 'incus-admin',
  },
  inspect: {
    timeoutMs: 120_000,
    maxOutputBytes: 8 * 64 * 1_024,
  },
  apply: {
    maxOutputBytes: 64 * 1_024,
    refusalCodes: {
      first: 20,
      last: 99,
    },
  },
  steps: STEPS,
} as const)

export const ARCHITECTURES = ['amd64', 'arm64'] as const

export type Architecture = (typeof ARCHITECTURES)[number]
export type IncusAction = keyof typeof STEPS
export const INCUS_ACTIONS = Object.keys(STEPS) as IncusAction[]

export const REQUIRED_PACKAGES: readonly string[] = [...INCUS_SPEC.packages, ...INCUS_SPEC.companions]
export const EXCLUDED_PACKAGES: readonly string[] = INCUS_SPEC.excluded

export function affectsStorage(action: IncusAction): boolean {
  return STEPS[action].storage
}

/**
 * The steps that let the daemon run against the state directory. Whichever of
 * them ran last decides whether Incus may hold the pool.
 */
export function opens(action: IncusAction): boolean {
  return action === 'open' || action === 'initialize'
}

/**
 * The steps that stop the workloads and the daemon again. A verified `release`
 * after the last opening is what establishes that Incus was released.
 */
export function releases(action: IncusAction): boolean {
  return action === 'stop-workloads' || action === 'release'
}

/**
 * The two required packages share one full native package version.
 */
export function packagePins(architecture: Architecture) {
  return REQUIRED_PACKAGES.map(name => ({
    name,
    version: INCUS_SPEC.packageVersions[architecture],
    architecture,
  }))
}

/**
 * The deb822 source for the verified dpkg architecture. The exact text is
 * hashed into the approved plan, so it is never regenerated from other inputs.
 */
export function repositorySource(architecture: Architecture): string {
  const { uri, suite, component, keyFile } = INCUS_SPEC.repository
  return (
    [
      'Enabled: yes',
      'Types: deb',
      `URIs: ${uri}`,
      `Suites: ${suite}`,
      `Components: ${component}`,
      `Architectures: ${architecture}`,
      `Signed-By: ${keyFile}`,
    ].join('\n') + '\n'
  )
}

/**
 * APT uses the first matching specific record, so the exact version precedes
 * the exclusion. Priority 1000 selects it without authorizing a downgrade.
 * Explicit administrator overrides remain outside this configuration.
 */
export function repositoryPreferences(architecture: Architecture): string {
  const packages = REQUIRED_PACKAGES.join(' ')
  return (
    [
      '# Managed by Qiln. Do not edit.',
      `Package: ${packages}`,
      `Pin: version ${INCUS_SPEC.packageVersions[architecture]}`,
      'Pin-Priority: 1000',
      '',
      `Package: ${packages}`,
      'Pin: version *',
      'Pin-Priority: -1',
    ].join('\n') + '\n'
  )
}

/**
 * The exact text of the sysctl override. Its digest is hashed into the approved
 * close plan, so it is never regenerated from other inputs.
 */
export function sysctlOverride(): string {
  const { key, value } = INCUS_SPEC.sysctl
  return ['# Managed by Qiln. Do not edit.', `${key}=${value}`].join('\n') + '\n'
}
