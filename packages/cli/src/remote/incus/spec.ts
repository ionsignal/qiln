interface RunSpec {
  script: 'repository' | 'refresh' | 'packages' | 'init' | 'release'
  timeoutMs: number
  refusals: Readonly<Record<number, string>>
}

interface StepSpec {
  storage: boolean
  run: RunSpec
}

/**
 * The one enumeration of Incus preparation steps. `storage` marks the steps that
 * can leave Incus data on the pool or its outcome unknown, and only those block
 * removal and volume handoff. A step names one embedded script, its deadline,
 * and the wording of every exit code that script uses to refuse before any
 * effect. Arguments are built from the approved plan by `apply.ts`.
 */
const STEPS = {
  'add-repository': {
    storage: false,
    run: {
      script: 'repository',
      timeoutMs: 60_000,
      refusals: {
        20: 'The repository file paths, key URL, source contents, or digests were not given or are malformed.',
        21: 'The APT keyring or source directory does not exist, or a file could not be staged.',
        22: 'The source bytes do not match their approved SHA-256 digest.',
        23: 'An existing repository file is not a regular file holding exactly the approved bytes.',
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
  initialize: {
    storage: true,
    run: {
      script: 'init',
      timeoutMs: 300_000,
      refusals: {
        20: 'The preseed, its digest, or the recorded pool name or GUID was not given or is malformed.',
        21: 'The Incus client was not found.',
        22: 'The preseed does not match its approved SHA-256 digest.',
        23: 'The Incus daemon socket is not active, and Qiln does not start it.',
        24: 'A storage pool already exists, so this is not a fresh initialization.',
        25: 'An instance already exists, so this is not a fresh initialization.',
        26: 'The preseed could not be staged.',
        27: 'The Incus API could not be read before initialization.',
        28: 'The recorded ZFS pool is not imported with the approved GUID.',
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
        20: 'The packaged Incus daemon unit was not found.',
        21: 'The Incus client could not be prepared.',
      },
    },
  },
} as const satisfies Record<string, StepSpec>

/**
 * Reviewed coordinates and fixed limits of the Incus preparation recipe.
 *
 * - `packages` are simulated and installed, `companions` must arrive with them,
 *   and `excluded` packages are refused if present.
 * - The `stable` channel is not a version pin. Exact versions are frozen per
 *   approval, and each must be listed with the repository URI below.
 * - The signing key is downloaded on the host from `keyUrl` and must match
 *   `keySha256`, the SHA-256 of the raw file bytes. A rotated or re-issued key
 *   fails closed and needs a new reviewed constant. `fingerprint` is review
 *   metadata only, because the host verifies the file digest and not the
 *   OpenPGP fingerprint.
 * - `units` are the Incus units whose positive inactivity establishes
 *   quiescence. They must match the units reported by the inspection script.
 * - `requiredExtensions` gate the `zfs.export` pool key, which keeps the Incus
 *   driver from exporting the whole pool when it unmounts.
 * - `maximumInstalls` is provisional. Set it from the closure observed on a
 *   real host.
 */
export const INCUS_SPEC = Object.freeze({
  recipeRevision: 1,
  maximumInstalls: 64,
  packages: ['incus-base'],
  companions: ['incus-client'],
  excluded: ['incus', 'incus-ui-canonical', 'incus-extra'],
  units: ['incus.socket', 'incus.service', 'incus-user.socket', 'incus-user.service', 'incus-startup.service'],
  requiredExtensions: ['storage_zfs_export'],
  repository: {
    uri: 'https://pkgs.zabbly.com/incus/stable',
    suite: 'resolute',
    component: 'main',
    fingerprint: '4EFC590696CB15B87C73A3AD82CC8797C838DCFD',
    keyUrl: 'https://pkgs.zabbly.com/key.asc',
    keySha256: 'f1adb44fdf82083f983a392b5b406d34e473dce3d66a51de3118cdc1f51d3f87',
    keyFile: '/etc/apt/keyrings/zabbly.asc',
    sourceFile: '/etc/apt/sources.list.d/zabbly-incus-stable.sources',
  },
  network: {
    name: 'incusbr0',
    address: '10.10.10.1/24',
    subnet: '10.10.10.0/24',
    dhcpRange: '10.10.10.100-10.10.10.200',
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
