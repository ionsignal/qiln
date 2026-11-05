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

export type PoolTarget = Pick<IncusTarget, 'pool' | 'guid' | 'datasets'>
export type ReleaseTarget = Pick<IncusTarget, 'pool' | 'guid' | 'account'>

export interface SoftwareTarget {
  account: string
  retained: Retained | null
}

export interface IncusTarget extends SoftwareTarget {
  pool: string
  guid: string
  datasets: PoolDatasets
}

export interface InspectTarget {
  pool: string | null
  account: string
  pins: readonly PackageChange[] | null
  closure: readonly PackageChange[] | null
}
export interface Progress {
  opened: boolean
  retained: PreseedDocument | null
  baseline: Baseline | null
  pins: readonly PackageChange[] | null
  closure: readonly PackageChange[] | null
  artifacts: Manifest | null
}

export const packageChangeSchema = z.strictObject({
  name: text,
  version: text,
  architecture: text,
})

export const manifestEntrySchema = z.strictObject({
  name: text,
  version: text,
  architecture: text,
  filename: text,
  size: z.int().positive(),
  sha256,
  source: text,
})

export const manifestSchema = z.array(manifestEntrySchema).min(1).max(256)

export type ManifestEntry = z.infer<typeof manifestEntrySchema>
export type Manifest = z.infer<typeof manifestSchema>

const idRangeSchema = z.strictObject({
  start: count,
  count: z.int().positive(),
})

export const allocationsSchema = z.strictObject({
  uid: z.array(idRangeSchema).min(1).max(64),
  gid: z.array(idRangeSchema).min(1).max(64),
})

export type IdRange = z.infer<typeof idRangeSchema>
export type Allocations = z.infer<typeof allocationsSchema>

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

const observedFileSchema = z.strictObject({
  kind: z.enum(['absent', 'file', 'other']),
  sha256: sha256.nullable(),
})

const stagedFileSchema = z.strictObject({
  name: text,
  size: count,
  sha256,
})

const indexEntrySchema = z.strictObject({
  package: text,
  version: text,
  architecture: text,
  filename: text,
  size: count,
  sha256,
})

/**
 * Normalized, bounded evidence from one inspection. A missing capability is a
 * value (`null` or `false`), never an empty result.
 * - `api` is null unless the daemon service itself is running, because a query
 *   through an active socket alone would start the daemon. Everything else is
 *   offline evidence that never touches an Incus socket.
 * - `repository` and `guard` report files by digest, `candidates` are the
 *   `apt-cache madison` rows, and `transaction` simulates the exact selected
 *   versions without changing the host.
 * - `stage` lists the regular package files of the staging directory, and
 *   `index` the repository index records of the closure that was asked about.
 *   Both are empty unless a closure was asked about.
 * - `sysctl.apparmor` is null when the key could not be read.
 * - `access` comes from the account database, not from a live SSH session.
 * - A null `idmap` list means the file was unreadable, which is not the same as
 *   a readable file without a root range.
 * - `stateMount` and `artifactsMount` are null when nothing was reported, which
 *   is a missing observation and not proof of absence. `state` reports whether
 *   the state directory is empty and whether every retained metadata entry is
 *   present.
 * - A service reports its load state, so an absent unit (`not-found`) differs
 *   from a loaded one, and its enablement shows a persistent (`masked`) or
 *   runtime (`masked-runtime`) mask.
 * - The server certificate fingerprint is not the SSH host-key fingerprint.
 *   `lxc` and an instance's `autostart` are null when unreported or unset.
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
    key: observedFileSchema,
    source: observedFileSchema,
    preferences: observedFileSchema,
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
    override: observedFileSchema,
    apparmor: text.nullable(),
  }),
  guard: z.strictObject({
    expectation: observedFileSchema,
    check: observedFileSchema,
    dropIn: observedFileSchema,
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
  stage: z.array(stagedFileSchema).max(512),
  index: z.array(indexEntrySchema).max(512),
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
  artifactsMount: mountSchema.nullable(),
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
export type StagedFile = z.infer<typeof stagedFileSchema>
export type IndexEntry = z.infer<typeof indexEntrySchema>
export type Identity = z.infer<typeof identitySchema>

export const identitySchema = z.strictObject({
  certificateFingerprint: sha256,
  standalone: z.literal(true),
})

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
 * The baseline matches the approved preseed and the administrator account has
 * Incus socket access, so nothing is left to apply. Never persisted.
 */
export interface ReadyPlan {
  kind: 'ready'
  pool: string
  guid: string
}

/**
 * The host is closed and the software stage has nothing left to apply: the
 * approved packages are installed, or a recorded installation is waiting for
 * the activation stage to restore its retained package files. Never persisted.
 */
export interface SoftwarePlan {
  kind: 'software'
}

/**
 * The Incus build that selection chose from the approved repository's lists. It
 * grants nothing: the preparer only simulates the chosen versions, and the
 * packages plan that follows shows and freezes the whole transaction. Never
 * persisted.
 */
export interface SelectPlan {
  kind: 'select'
  pins: PackageChange[]
}

/**
 * Every Incus unit is positively inactive and a verified release is already recorded,
 * so there is nothing to release. Never persisted.
 */
export interface StoppedPlan {
  kind: 'stopped'
}

const digestSchema = z.strictObject({ sha256 })

/**
 * Writes the approved signing key and source when absent, then refreshes the
 * package lists. Existing files are never overwritten, and the digests identify
 * the exact approved bytes.
 */
export const repositoryPlanSchema = z.strictObject({
  kind: z.literal('repository'),
  architecture: z.enum(ARCHITECTURES),
  add: z.boolean(),
  key: z.strictObject({ url: text, sha256 }),
  source: digestSchema,
})

/**
 * Masks every Incus unit persistently, so no package can start the daemon, and
 * installs the sysctl override that keeps the AppArmor restriction enabled. It
 * names no pool, because it runs before any storage exists. `repository` follows
 * the closing under the same approval, and is null when the repository files and
 * refreshed lists are already in place, or when a recorded installation is
 * restored from its retained files and needs no repository.
 */
export const closePlanSchema = z.strictObject({
  kind: z.literal('close'),
  sysctl: digestSchema,
  repository: repositoryPlanSchema.nullable(),
})

/**
 * The three root-owned files that keep the daemon from starting unless the
 * recorded state dataset is mounted, by approved digest.
 */
const guardFilesSchema = z.strictObject({
  expectation: digestSchema,
  check: digestSchema,
  dropIn: digestSchema,
})

/**
 * Pins the selected version in the APT preferences, then installs the frozen
 * transaction. `preferences` names the version and the digest of the exact
 * approved bytes.
 */
export const packagesPlanSchema = z.strictObject({
  kind: z.literal('packages'),
  install: z.array(packageChangeSchema).max(256),
  preferences: z.strictObject({ version: text, sha256 }),
})

/**
 * Copies the staged package files of the installed transaction onto the
 * artifacts dataset inside one mount window. The dataset identity and the exact
 * manifest are frozen with the approval, and the manifest is what a later
 * restore will judge the retained files against.
 */
export const capturePlanSchema = z.strictObject({
  kind: z.literal('capture'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema,
  manifest: manifestSchema,
})

/**
 * Pins the recorded version in the APT preferences, then installs the retained
 * package files of a preserved installation from the artifacts dataset inside
 * one mount window, with no repository involved. The manifest is the one that
 * the earlier capture froze, and the preferences are the exact approved bytes.
 */
export const restorePlanSchema = z.strictObject({
  kind: z.literal('restore'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema,
  manifest: manifestSchema,
  preferences: z.strictObject({ version: text, sha256 }),
})

/**
 * The installation of an earlier deployment that a preserved open reopens: the
 * retained preseed bytes, the recorded software and subordinate-ID ranges, the
 * server identity that the reopened daemon must present, and the manifest of
 * the retained package files. `origin` is the deployment whose evidence
 * established the installation. It grants no authority.
 */
export const retainedSchema = z.strictObject({
  origin: operationId,
  preseed: z.strictObject({
    yaml: z.string().min(1).max(16_384),
    sha256,
  }),
  baseline: baselineSchema,
  identity: identitySchema,
  artifacts: manifestSchema,
})

export type Retained = z.infer<typeof retainedSchema>

/**
 * Lets the daemon run. `install` is set when any guard file is absent, and the
 * same approval then also writes the guard before the daemon starts.
 * - A fresh open (`retained` null) needs an empty state directory and a large
 *   enough root range in each subordinate-ID file, and an initialization follows.
 * - A preserved open needs the retained metadata and every recorded root range,
 *   initializes nothing, and never falls back to a fresh installation.
 * Installing packages never opens the daemon.
 */
export const openPlanSchema = z.strictObject({
  kind: z.literal('open'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema,
  guard: guardFilesSchema,
  install: z.boolean(),
  retained: retainedSchema.nullable(),
})

/**
 * The preseed is retained as the exact approved bytes, which verification reads
 * back, so they stay the single source. The dataset identities are retained too,
 * because the mounted state is verified against them.
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
 * Stops the frozen instance inventory, then releases the daemon. The workload
 * step refuses if the host no longer matches the inventory observed at planning.
 */
export const releasePlanSchema = z.strictObject({
  kind: z.literal('release'),
  pool: poolNameSchema,
  guid,
  instances: z.array(instanceRefSchema).max(256),
})

export type ClosePlan = z.infer<typeof closePlanSchema>
export type RepositoryPlan = z.infer<typeof repositoryPlanSchema>
export type PackagesPlan = z.infer<typeof packagesPlanSchema>
export type CapturePlan = z.infer<typeof capturePlanSchema>
export type RestorePlan = z.infer<typeof restorePlanSchema>
export type OpenPlan = z.infer<typeof openPlanSchema>
export type InitializePlan = z.infer<typeof initializePlanSchema>
export type AccessPlan = z.infer<typeof accessPlanSchema>
export type ReleasePlan = z.infer<typeof releasePlanSchema>

/**
 * The plans that ask for approval and are persisted with it.
 */
export type ApprovedPlan =
  | ClosePlan
  | RepositoryPlan
  | PackagesPlan
  | CapturePlan
  | RestorePlan
  | OpenPlan
  | InitializePlan
  | AccessPlan
  | ReleasePlan

/**
 * What `softwarePlanOf` can decide.
 */
export type SoftwareStagePlan = RefusedPlan | ClosePlan | RepositoryPlan | SelectPlan | PackagesPlan | SoftwarePlan

/**
 * What `planOf` can decide.
 */
export type PreparationPlan =
  | RefusedPlan
  | ReadyPlan
  | ClosePlan
  | RepositoryPlan
  | SelectPlan
  | PackagesPlan
  | CapturePlan
  | RestorePlan
  | OpenPlan
  | InitializePlan
  | AccessPlan

/**
 * Preparation plans plus what `releasePlanOf` decides, only before ZFS export.
 */
export type Plan = PreparationPlan | ReleasePlan | StoppedPlan

function repositoryActions(plan: RepositoryPlan): readonly IncusAction[] {
  return plan.add ? ['add-repository', 'refresh-lists'] : ['refresh-lists']
}

/**
 * The repository plan an approved plan carries: itself, or the one that follows
 * a closing under the same approval. Null means it carries none.
 */
export function repositoryOf(plan: ApprovedPlan): RepositoryPlan | null {
  if (plan.kind === 'repository') {
    return plan
  }
  return plan.kind === 'close' ? plan.repository : null
}

/**
 * The steps one approved plan allows, in the order they run. A step whose
 * action is not listed here was never authorized.
 */
export function actionsOf(plan: ApprovedPlan): readonly IncusAction[] {
  switch (plan.kind) {
    case 'close':
      return plan.repository === null ? ['close'] : ['close', ...repositoryActions(plan.repository)]
    case 'repository':
      return repositoryActions(plan)
    case 'packages':
      return ['pin-versions', 'install-packages']
    case 'capture':
      return ['capture']
    case 'restore':
      return ['pin-versions', 'restore']
    case 'open':
      return plan.install ? ['guard', 'open'] : ['open']
    case 'initialize':
      return ['initialize']
    case 'access':
      return ['grant-access']
    case 'release':
      return ['stop-workloads', 'release']
  }
}
