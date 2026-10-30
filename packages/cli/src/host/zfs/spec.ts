const MIB = 1_048_576

interface RunSpec {
  script: 'packages' | 'arc' | 'module' | 'create' | 'datasets' | 'import' | 'state' | 'scrub' | 'export'
  timeoutMs: number
  refusals: Readonly<Record<number, string>>
}

interface StepSpec {
  pool: boolean
  run: RunSpec
}

/**
 * The one enumeration of preparation steps. `pool` marks the steps that can
 * leave a pool imported, its datasets or state mount changed, or its outcome
 * unknown, and only those block disconnect and volume handoff, and they alone
 * block the first removal gate. Removal that must release the host over SSH
 * additionally needs every other step settled, because the journal accepts no
 * new work after an unresolved step. A step names one embedded script, its
 * deadline, and the wording of every exit code that script uses to refuse
 * before any effect. Arguments are built from the approved plan by `apply.ts`,
 * never supplied by a caller.
 */
const STEPS = {
  'install-packages': {
    pool: false,
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
  'write-arc': {
    pool: false,
    run: {
      script: 'arc',
      timeoutMs: 30_000,
      refusals: {
        20: 'The ARC file path or value was not given.',
        21: 'The modprobe configuration directory does not exist.',
        22: 'The ARC file path exists but is not a regular file, so it was not replaced.',
        23: 'The ARC file could not be staged beside its destination.',
      },
    },
  },
  'load-module': {
    pool: false,
    run: {
      script: 'module',
      timeoutMs: 60_000,
      refusals: {
        20: 'No ZFS kernel module was found for the running kernel.',
      },
    },
  },
  'apply-arc': {
    pool: false,
    run: {
      script: 'arc',
      timeoutMs: 30_000,
      refusals: {
        20: 'The ARC value was not a number.',
        21: 'The running ZFS module does not expose a writable ARC limit.',
      },
    },
  },
  'create-pool': {
    pool: true,
    run: {
      script: 'create',
      timeoutMs: 120_000,
      refusals: {
        20: 'The pool name, target device, volume ID, or a pool setting was not given or is malformed.',
        21: 'The target is not a block device, or the ZFS module or tools are not available.',
        22: 'The target device does not carry the approved EBS volume ID.',
        23: 'The target device is no longer a confirmed blank disk.',
        24: 'A pool with the approved name is already imported.',
      },
    },
  },
  'create-datasets': {
    pool: true,
    run: {
      script: 'datasets',
      timeoutMs: 60_000,
      refusals: {
        20: 'The pool name, a dataset name, or the state mountpoint was not given or is malformed.',
        21: 'The ZFS module or tools are not available.',
        22: 'The pool is not imported.',
        23: 'The pool already holds datasets, or its datasets could not be listed.',
      },
    },
  },
  'import-pool': {
    pool: true,
    run: {
      script: 'import',
      timeoutMs: 120_000,
      refusals: {
        20: 'The pool name, GUID, device, volume ID, or member partition was not given or is malformed.',
        21: 'The ZFS module or tools are not available.',
        22: 'The approved pool GUID was not found among the importable pools on the approved member partition.',
        23: 'The pool found for the approved GUID has a different name than the one approved.',
        24: 'A pool with the approved name or GUID is already imported under a different identity.',
        25: 'The target device does not carry the approved EBS volume ID.',
        26: 'The target device no longer has exactly the approved ZFS member partition.',
      },
    },
  },
  'mount-state': {
    pool: true,
    run: {
      script: 'state',
      timeoutMs: 60_000,
      refusals: {
        20: 'The pool name, a GUID, the dataset name, or the mountpoint was not given or is malformed.',
        21: 'The ZFS module, the ZFS tools, or findmnt is not available.',
        22: 'The recorded pool is not imported with the approved GUID.',
        23: 'The state dataset is missing, is not a filesystem, or does not have the approved GUID.',
        24: 'The state dataset does not have the approved mountpoint and canmount=noauto set locally.',
        25: 'Something is already mounted at the state directory.',
      },
    },
  },
  'unmount-state': {
    pool: true,
    run: {
      script: 'state',
      timeoutMs: 120_000,
      refusals: {
        20: 'The pool name, a GUID, the dataset name, or the mountpoint was not given or is malformed.',
        21: 'The ZFS module, the ZFS tools, or findmnt is not available.',
        22: 'The recorded pool is not imported with the approved GUID.',
        23: 'The state dataset is missing, is not a filesystem, or does not have the approved GUID.',
        24: 'The state dataset does not have the approved mountpoint and canmount=noauto set locally.',
        26: 'The state dataset is not mounted.',
        27: 'Another filesystem is mounted beneath the state directory.',
      },
    },
  },
  'export-pool': {
    pool: true,
    run: {
      script: 'export',
      timeoutMs: 300_000,
      refusals: {
        20: 'The pool name or GUID was not given or is malformed.',
        21: 'The ZFS module or tools are not available.',
        22: 'The recorded pool is not imported.',
        23: 'The imported pool has a different GUID than the one recorded.',
        24: 'A dataset of the pool is mounted, or its mount state could not be read.',
        25: 'A scrub or resilver is in progress, or the pool status could not be read.',
      },
    },
  },
  'enable-scrub': {
    pool: false,
    run: {
      script: 'scrub',
      timeoutMs: 60_000,
      refusals: {
        20: 'The pool name was not given or is malformed.',
        21: 'The packaged monthly scrub timer unit was not found.',
        22: 'The pool is not imported.',
      },
    },
  },
} as const satisfies Record<string, StepSpec>

/**
 * Reviewed defaults and fixed limits of the ZFS preparation recipe. Policy
 * selects how a pool is configured, never which resource is touched.
 * `cachefile=none` keeps pool import explicit: no unattended import mechanism
 * is introduced here, and boot persistence belongs to the later host slice.
 * `layout` names the two datasets of the pool: `state` is mounted at the Incus
 * state directory only by an explicit step, and `incus` is reserved for the
 * Incus storage driver. Its revision identifies this arrangement, so another
 * arrangement is never mistaken for it.
 * `maximumInstalls` bounds the resolved package transaction that an approval
 * would freeze, so an unexpectedly large dependency closure is refused.
 * Script exit codes from `refusalCodes.first` to `refusalCodes.last` are
 * authored refusals that happen before any effect.
 */
export const ZFS_SPEC = Object.freeze({
  recipeRevision: 1,
  maximumInstalls: 16,
  packages: ['zfsutils-linux'],
  scrubTemplate: 'zfs-scrub-monthly@.timer',
  defaults: {
    poolName: 'qiln-pool',
    arcMaxPercent: 25,
    ashift: 12,
    autotrim: 'on',
    compression: 'lz4',
    atime: 'off',
  },
  pool: {
    cachefile: 'none',
    mountpoint: 'none',
    acltype: 'posixacl',
    xattr: 'sa',
  },
  layout: {
    revision: 1,
    state: 'server-state',
    incus: 'incus',
  },
  arc: {
    file: '/etc/modprobe.d/qiln-zfs.conf',
    minimumMaxBytes: 64 * MIB,
    floorMinimumBytes: 32 * MIB,
    minimumDivisor: 32,
  },
  inspect: {
    timeoutMs: 120_000,
    maxOutputBytes: 262_144,
  },
  apply: {
    maxOutputBytes: 65_536,
    refusalCodes: {
      first: 20,
      last: 99,
    },
  },
  steps: STEPS,
} as const)

export type StepAction = keyof typeof STEPS
export const STEP_ACTIONS = Object.keys(STEPS) as StepAction[]

export function isPoolAction(action: StepAction): boolean {
  return STEPS[action].pool
}

export function scrubTimerOf(pool: string): string {
  return `zfs-scrub-monthly@${pool}.timer`
}

/**
 * The full dataset names of one pool's layout.
 */
export function datasetNamesOf(pool: string): { state: string; incus: string } {
  return { state: `${pool}/${ZFS_SPEC.layout.state}`, incus: `${pool}/${ZFS_SPEC.layout.incus}` }
}

export function arcLine(bytes: number): string {
  return `options zfs zfs_arc_max=${bytes}`
}

/**
 * The owned file matches when its only non-comment line is the approved limit.
 */
export function arcFileMatches(ownedLines: readonly string[] | null, bytes: number): boolean {
  const owned = ownedLines?.filter(line => !line.startsWith('#')) ?? null
  return owned !== null && owned.length === 1 && owned[0] === arcLine(bytes)
}
