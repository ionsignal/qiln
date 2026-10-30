import { z } from 'zod'
import { ARCHITECTURES, REQUIRED_PACKAGES, type IncusAction } from './spec'
import { operationId } from '../../journal/step'
import { mountSchema } from '../mount'
import { datasetSchema, poolDatasetsSchema, poolNameSchema, type PoolDatasets } from '../zfs/types'
import type { PreseedDocument } from './preseed'

const text = z.string().min(1).max(2_048)
const count = z.int().nonnegative()
const guid = z.string().regex(/^[0-9]+$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const settings = z.record(z.string(), z.string())
const account = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/)

/**
 * What an installation of software needs to know about the target: the
 * administrator account that needs Incus socket access, and the Incus
 * installation of an earlier deployment that this host may reopen, or null for a
 * fresh installation. No pool is needed, because software is prepared while no
 * pool is mounted.
 */
export interface SoftwareTarget {
  account: string
  retained: Retained | null
}

/**
 * Software plus the pool that earlier ZFS preparation evidence expects on the
 * data volume and its two datasets. All are derived from the protected
 * deployment record and its retained evidence, never from the host.
 */
export interface IncusTarget extends SoftwareTarget {
  pool: string
  guid: string
  datasets: PoolDatasets
}

/**
 * The recorded identities that the storage-identity guard and the mounted-state
 * checks compare with the host.
 */
export type PoolTarget = Pick<IncusTarget, 'pool' | 'guid' | 'datasets'>

/**
 * What an inspection needs to know about the target. A null pool reports no ZFS
 * pool. The retained software is only needed to simulate its exact packages
 * before a preserved open.
 */
export interface InspectTarget {
  pool: string | null
  account: string
  retained?: Retained | null
}

/**
 * What the release before the ZFS export needs to know about the target.
 */
export type ReleaseTarget = Pick<IncusTarget, 'pool' | 'guid' | 'account'>

/**
 * What retained evidence says about earlier preparation. `opened` means a
 * verified open or initialization let the daemon run, so the closed host is no
 * longer expected. `retained` is the preseed document of a verified
 * initialization, or of a verified open of a preserved installation.
 */
export interface Progress {
  opened: boolean
  retained: PreseedDocument | null
}

export const packageChangeSchema = z.strictObject({
  name: text,
  version: text,
  architecture: text,
})

/**
 * One root range of a subordinate-ID file.
 */
const idRangeSchema = z.strictObject({
  start: count,
  count: z.int().positive(),
})

/**
 * The root ranges of `/etc/subuid` and `/etc/subgid`. Retained instance
 * ownership depends on them, and Qiln never edits either file. A baseline always
 * holds at least one range in each.
 */
export const allocationsSchema = z.strictObject({
  uid: z.array(idRangeSchema).min(1).max(64),
  gid: z.array(idRangeSchema).min(1).max(64),
})

export type IdRange = z.infer<typeof idRangeSchema>
export type Allocations = z.infer<typeof allocationsSchema>

/**
 * The installed Incus packages and relevant runtime dependencies with their full
 * versions, the native package architecture, and the root subordinate-ID ranges.
 * It is not the original APT transaction: a dependency that already matched is
 * part of the baseline all the same. It is evidence of what was running, and it
 * grants no authority.
 */
export const baselineSchema = z
  .strictObject({
    architecture: z.enum(ARCHITECTURES),
    packages: z.array(packageChangeSchema).min(1).max(256),
    allocations: allocationsSchema,
  })
  .refine(
    ({ packages }) => REQUIRED_PACKAGES.every(name => packages.some(item => item.name === name)),
    'Expected every required Incus package.',
  )

export type Baseline = z.infer<typeof baselineSchema>

const fileSchema = z.strictObject({
  kind: z.enum(['absent', 'file', 'other']),
  sha256: sha256.nullable(),
})

/**
 * Normalized, bounded evidence from one inspection. A missing capability is a
 * value here (`null` or `false`), never an empty result. `api` is null unless
 * the daemon service itself is already running, because a query through an
 * active socket alone would start the daemon by socket activation, and Qiln
 * never reads the API in a way that could do that. Everything else is offline
 * evidence that never touches an Incus socket: `system` also holds the running
 * kernel and the machine architecture, `runtime` the ZFS versions where they
 * could be read, and `software` every installed package that matches the
 * recorded software patterns, with its full version. `packages` lists installed
 * packages only, and its bound exceeds the largest approved transaction.
 * `repository` reports the key, source, and exact-package preferences by digest,
 * and `repository.candidates` holds the `apt-cache madison` rows. `transaction`
 * simulates exact selected or retained versions and never changes the host.
 * `sysctl` reports the Qiln override file by digest and the running value of the
 * AppArmor restriction key that it pins, which is null when it could not be read.
 * `guard` reports the three files that protect the state directory by digest.
 * `network` holds host routes that overlap the bridge subnet, ignoring the
 * default route, and every link name.
 * `access` is read from the account database, so it shows a recorded group
 * membership and not whether an open SSH connection already has it.
 * `idmap` holds the root ranges of each subordinate-ID file. A null list means
 * the file could not be read, which is not the same as an empty list, a file
 * that was read and holds no root range.
 * `zfs.datasets` are every dataset of the inspected pool, when it is imported,
 * and `zfs.topLevel` describes the pool dataset and its direct children with
 * their GUIDs and mount properties. `stateMount` is the kernel mount-table entry
 * at the Incus state directory, and null when none was reported, which is a
 * missing observation and not proof that nothing is mounted. `state` reports
 * whether the state directory holds nothing, and whether every retained
 * metadata entry is present; a directory that could not be listed reports
 * neither.
 * Each service reports its load state, so an absent unit (`not-found`) is told
 * apart from a loaded one, and its enablement reports a persistent (`masked`)
 * or runtime (`masked-runtime`) mask.
 * The API server reports its certificate fingerprint, which is not the SSH host
 * key fingerprint, whether it is clustered, and the LXC version that the daemon
 * itself reports, which is null when it reports none. Every instance of every
 * project reports whether it is ephemeral and its local `boot.autostart` value,
 * which is null when it is unset.
 */
export const observationSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  system: z.strictObject({
    packageArchitecture: text,
    machine: text,
    kernel: text,
    ipForward: z.boolean(),
  }),
  runtime: z.strictObject({
    zfs: text.nullable(),
    zfsModule: text.nullable(),
  }),
  repository: z.strictObject({
    key: fileSchema,
    source: fileSchema,
    preferences: fileSchema,
    conflicts: z.array(text).max(16),
    candidates: z
      .array(
        z.strictObject({
          package: text,
          version: text,
          source: text,
        }),
      )
      .max(256),
  }),
  sysctl: z.strictObject({
    override: fileSchema,
    apparmor: text.nullable(),
  }),
  guard: z.strictObject({
    expectation: fileSchema,
    check: fileSchema,
    dropIn: fileSchema,
  }),
  packages: z.array(packageChangeSchema).max(128),
  software: z.array(packageChangeSchema).max(256),
  transaction: z
    .strictObject({
      installs: z.array(packageChangeSchema).max(256),
      configures: z.array(text).max(512),
      upgrades: z.array(text).max(512),
      removals: z.array(text).max(512),
    })
    .nullable(),
  services: z
    .array(
      z.strictObject({
        unit: text,
        load: text,
        enablement: text,
        activation: text,
      }),
    )
    .max(16),
  listeners: z.array(text).max(64),
  network: z.strictObject({
    routes: z.array(text).max(64),
    links: z.array(text).max(256),
  }),
  access: z.strictObject({
    account: text,
    groupExists: z.boolean(),
    member: z.boolean(),
  }),
  idmap: z.strictObject({
    uid: z.array(idRangeSchema).max(64).nullable(),
    gid: z.array(idRangeSchema).max(64).nullable(),
  }),
  zfs: z.strictObject({
    available: z.boolean(),
    pool: z.strictObject({ name: text, guid }).nullable(),
    datasets: z
      .array(
        z.strictObject({
          name: text,
          mounted: z.boolean(),
        }),
      )
      .max(4_096),
    topLevel: z.array(datasetSchema).max(64),
  }),
  stateMount: mountSchema.nullable(),
  state: z.strictObject({
    empty: z.boolean(),
    metadata: z.boolean(),
  }),
  api: z
    .strictObject({
      server: z.strictObject({
        config: settings,
        extensions: z.array(text).max(1_024),
        version: text,
        certificateFingerprint: text,
        clustered: z.boolean(),
        lxc: text.nullable(),
      }),
      projects: z.array(text).max(64),
      pools: z
        .array(z.strictObject({ name: text, driver: text, config: settings }))
        .max(64),
      networks: z
        .array(z.strictObject({ name: text, type: text, managed: z.boolean(), config: settings }))
        .max(256),
      profiles: z
        .array(z.strictObject({ name: text, config: settings, devices: z.record(z.string(), settings) }))
        .max(256),
      instances: z
        .array(
          z.strictObject({
            project: text,
            name: text,
            status: text,
            ephemeral: z.boolean(),
            autostart: text.nullable(),
          }),
        )
        .max(4_096),
      images: count,
    })
    .nullable(),
})

export type Observation = z.infer<typeof observationSchema>
export type Api = NonNullable<Observation['api']>
export type PackageChange = z.infer<typeof packageChangeSchema>

/**
 * The identity of the Incus server that an initialization was verified against.
 * The certificate fingerprint is not the SSH host-key fingerprint, and it is
 * evidence of which installation this is, not authorization to use it.
 */
export const identitySchema = z.strictObject({
  certificateFingerprint: sha256,
  standalone: z.literal(true),
})

export type Identity = z.infer<typeof identitySchema>

/**
 * Null means the observation holds no standalone server identity, so there is
 * nothing to record.
 */
export function identityOf(observation: Observation): Identity | null {
  const server = observation.api?.server
  if (server === undefined || server.clustered) {
    return null
  }
  const parsed = identitySchema.safeParse({ certificateFingerprint: server.certificateFingerprint, standalone: true })
  return parsed.success ? parsed.data : null
}

const instanceRefSchema = z.strictObject({
  project: text,
  name: text,
})

export type InstanceRef = z.infer<typeof instanceRefSchema>

export function instanceKey({ project, name }: InstanceRef): string {
  return `${project}/${name}`
}

export interface RefusedPlan {
  kind: 'refused'
  reasons: string[]
}

/**
 * The initialized baseline matches the approved preseed and the administrator
 * account has Incus socket access, so nothing is left to apply. This plan is
 * never persisted.
 */
export interface ReadyPlan {
  kind: 'ready'
  pool: string
  guid: string
}

/**
 * The host is closed and the approved Incus packages are installed, so the
 * software stage has nothing left to apply. This plan is never persisted.
 */
export interface SoftwarePlan {
  kind: 'software'
}

/**
 * Every Incus unit is positively inactive and a verified release is already
 * recorded, so there is nothing to release. Nothing is run or recorded for it.
 * This plan is never persisted.
 */
export interface StoppedPlan {
  kind: 'stopped'
}

const file = z.strictObject({ sha256 })

/**
 * Masks every Incus unit persistently, so no package can start the daemon, and
 * installs the sysctl override that keeps the AppArmor restriction enabled. The
 * digest identifies the exact approved override bytes. It names no pool,
 * because it runs before any storage exists.
 */
export const closePlanSchema = z.strictObject({
  kind: z.literal('close'),
  sysctl: file,
})

/**
 * Installs the storage-identity guard: the expectation file of the recorded
 * identities, the startup check, and the service drop-in. The digests identify
 * the exact approved bytes. The layout revision is a literal of the record
 * version, not a read of today's spec.
 */
export const guardPlanSchema = z.strictObject({
  kind: z.literal('guard'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema,
  layout: z.literal(1),
  expectation: file,
  check: file,
  dropIn: file,
})

/**
 * Writes the approved signing key, source, and exact-package preferences when
 * absent, then refreshes the package lists. Existing files are never
 * overwritten. The digests identify the exact approved bytes.
 */
export const repositoryPlanSchema = z.strictObject({
  kind: z.literal('repository'),
  architecture: z.enum(ARCHITECTURES),
  add: z.boolean(),
  key: z.strictObject({ url: text, sha256 }),
  source: file,
  preferences: file,
})

export const packagesPlanSchema = z.strictObject({
  kind: z.literal('packages'),
  install: z.array(packageChangeSchema).max(256),
})

/**
 * The Incus installation of an earlier deployment that a preserved open
 * reopens: the retained preseed bytes, the recorded software and subordinate-ID
 * ranges, and the server identity that the reopened daemon must present.
 * `origin` is the deployment whose evidence established them. Evidence of what
 * was running, which grants no authority.
 */
export const retainedSchema = z.strictObject({
  origin: operationId,
  preseed: z.strictObject({
    yaml: z.string().min(1).max(16_384),
    sha256,
  }),
  baseline: baselineSchema,
  identity: identitySchema,
})

export type Retained = z.infer<typeof retainedSchema>

/**
 * Lets the daemon run. With `retained` null it opens a fresh installation: the
 * state directory must be empty, each subordinate-ID file must list a large
 * enough root range, and an initialization follows. With `retained` it reopens
 * the preserved installation: the state directory must hold its retained
 * metadata, every recorded root range must be listed, nothing is initialized,
 * and a missing state never falls back to a fresh installation. The startup
 * check must confirm the recorded state dataset first. Installing packages
 * never does this.
 */
export const openPlanSchema = z.strictObject({
  kind: z.literal('open'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema,
  check: file,
  retained: retainedSchema.nullable(),
})

/**
 * The preseed is retained as the exact approved bytes. Verification reads the
 * expected state back from those bytes, so they stay the single source. The
 * dataset identities are retained too, because the mounted state is verified
 * against them.
 */
export const initializePlanSchema = z.strictObject({
  kind: z.literal('initialize'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema,
  preseed: z.strictObject({
    yaml: z.string().min(1).max(16_384),
    sha256,
  }),
})

/**
 * Adds the administrator account to the Incus administration group, which is
 * root-equivalent authority over the Incus Unix socket. The group is a literal
 * of the record version, not a read of today's spec.
 */
export const accessPlanSchema = z.strictObject({
  kind: z.literal('access'),
  account,
  group: z.literal('incus-admin'),
})

/**
 * Stops the frozen instance inventory, then releases the daemon: units are
 * masked and stopped. The inventory is what was observed when the plan was
 * made, and the workload step refuses if the host no longer matches it.
 */
export const releasePlanSchema = z.strictObject({
  kind: z.literal('release'),
  pool: poolNameSchema,
  guid,
  instances: z.array(instanceRefSchema).max(256),
})

export type ClosePlan = z.infer<typeof closePlanSchema>
export type GuardPlan = z.infer<typeof guardPlanSchema>
export type RepositoryPlan = z.infer<typeof repositoryPlanSchema>
export type PackagesPlan = z.infer<typeof packagesPlanSchema>
export type OpenPlan = z.infer<typeof openPlanSchema>
export type InitializePlan = z.infer<typeof initializePlanSchema>
export type AccessPlan = z.infer<typeof accessPlanSchema>
export type ReleasePlan = z.infer<typeof releasePlanSchema>

/**
 * The plans that ask for approval and are persisted with it.
 */
export type ApprovedPlan =
  | ClosePlan
  | GuardPlan
  | RepositoryPlan
  | PackagesPlan
  | OpenPlan
  | InitializePlan
  | AccessPlan
  | ReleasePlan

/**
 * What `softwarePlanOf` can decide.
 */
export type SoftwareStagePlan = RefusedPlan | ClosePlan | RepositoryPlan | PackagesPlan | SoftwarePlan

/**
 * What `planOf` can decide.
 */
export type PreparationPlan =
  | RefusedPlan
  | ReadyPlan
  | ClosePlan
  | RepositoryPlan
  | PackagesPlan
  | GuardPlan
  | OpenPlan
  | InitializePlan
  | AccessPlan

/**
 * Preparation plans plus what `releasePlanOf` decides, only before ZFS export.
 */
export type Plan = PreparationPlan | ReleasePlan | StoppedPlan

/**
 * The steps one approved plan allows, in the order they run. A step whose
 * action is not listed here was never authorized.
 */
export function actionsOf(plan: ApprovedPlan): readonly IncusAction[] {
  switch (plan.kind) {
    case 'close':
      return ['close']
    case 'guard':
      return ['guard']
    case 'repository':
      return plan.add ? ['add-repository', 'refresh-lists'] : ['refresh-lists']
    case 'packages':
      return ['install-packages']
    case 'open':
      return ['open']
    case 'initialize':
      return ['initialize']
    case 'access':
      return ['grant-access']
    case 'release':
      return ['stop-workloads', 'release']
  }
}
