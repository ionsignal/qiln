import { z } from 'zod'
import { poolNameSchema } from '../zfs/types'
import { ARCHITECTURES, type IncusAction } from './spec'

const text = z.string().min(1).max(2_048)
const count = z.int().nonnegative()
const guid = z.string().regex(/^[0-9]+$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const settings = z.record(z.string(), z.string())

/**
 * The pool that earlier ZFS preparation evidence expects on the data volume.
 * Derived from the protected deployment record, never from the host.
 */
export interface IncusTarget {
  pool: string
  guid: string
}

const packageChangeSchema = z.strictObject({
  name: text,
  version: text,
  architecture: text,
})

const fileSchema = z.strictObject({
  kind: z.enum(['absent', 'file', 'other']),
  sha256: sha256.nullable(),
})

/**
 * Normalized, bounded evidence from one inspection. A missing capability is a
 * value here (`null` or `false`), never an empty result. `api` is null when the
 * daemon sockets are inactive, because Qiln does not read the API in a way that
 * would reactivate a stopped daemon. `packages` lists installed packages only,
 * and its bound exceeds the largest approved transaction. `repository.candidates`
 * are the `apt-cache madison` rows, and `transaction` is a simulation that never
 * changes the host. `network` holds host routes that overlap the bridge subnet,
 * ignoring the default route, and every link name. `zfs.datasets` are the
 * datasets of the inspected pool, when it is imported.
 */
export const observationSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  system: z.strictObject({
    packageArchitecture: text,
    ipForward: z.boolean(),
  }),
  repository: z.strictObject({
    key: fileSchema,
    source: fileSchema,
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
  packages: z.array(packageChangeSchema).max(128),
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
  }),
  api: z
    .strictObject({
      server: z.strictObject({
        config: settings,
        extensions: z.array(text).max(1_024),
        version: text,
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
      instances: z.array(z.strictObject({ name: text, status: text })).max(4_096),
      images: count,
    })
    .nullable(),
})

export type Observation = z.infer<typeof observationSchema>
export type Api = NonNullable<Observation['api']>
export type PackageChange = z.infer<typeof packageChangeSchema>

export interface RefusedPlan {
  kind: 'refused'
  reasons: string[]
}

/**
 * The initialized baseline matches the approved preseed, so nothing is left to
 * apply. This plan is never persisted.
 */
export interface ReadyPlan {
  kind: 'ready'
  pool: string
  guid: string
}

/**
 * Every Incus unit is positively inactive, so there is nothing to release. This
 * plan is never persisted.
 */
export interface StoppedPlan {
  kind: 'stopped'
}

/**
 * Writes the approved signing key and source file, when either is absent, and
 * refreshes the package lists. The key is downloaded on the host from the
 * approved URL and must match its digest. The digests identify the exact
 * approved bytes.
 */
export const repositoryPlanSchema = z.strictObject({
  kind: z.literal('repository'),
  architecture: z.enum(ARCHITECTURES),
  add: z.boolean(),
  key: z.strictObject({ url: text, sha256 }),
  source: z.strictObject({ sha256 }),
})

export const packagesPlanSchema = z.strictObject({
  kind: z.literal('packages'),
  install: z.array(packageChangeSchema).max(256),
})

/**
 * The preseed is retained as the exact approved bytes. Verification reads the
 * expected state back from those bytes, so they stay the single source.
 */
export const initializePlanSchema = z.strictObject({
  kind: z.literal('initialize'),
  pool: poolNameSchema,
  guid,
  preseed: z.strictObject({
    yaml: z.string().min(1).max(16_384),
    sha256,
  }),
})

/**
 * Orderly shutdown of instances, then the daemon and its sockets. The number of
 * running instances is shown from the observation and is not persisted.
 */
export const releasePlanSchema = z.strictObject({
  kind: z.literal('release'),
  pool: poolNameSchema,
  guid,
})

export type RepositoryPlan = z.infer<typeof repositoryPlanSchema>
export type PackagesPlan = z.infer<typeof packagesPlanSchema>
export type InitializePlan = z.infer<typeof initializePlanSchema>
export type ReleasePlan = z.infer<typeof releasePlanSchema>

/**
 * The plans that ask for approval and are persisted with it.
 */
export type ApprovedPlan = RepositoryPlan | PackagesPlan | InitializePlan | ReleasePlan

/**
 * What `planOf` can decide.
 */
export type PreparationPlan = RefusedPlan | ReadyPlan | RepositoryPlan | PackagesPlan | InitializePlan

/**
 * Preparation plans plus what `releasePlanOf` decides, only before ZFS export.
 */
export type Plan = PreparationPlan | ReleasePlan | StoppedPlan

/**
 * The steps one approved plan allows. A step whose action is not listed here
 * was never authorized.
 */
export function actionsOf(plan: ApprovedPlan): readonly IncusAction[] {
  switch (plan.kind) {
    case 'repository':
      return plan.add ? ['add-repository', 'refresh-lists'] : ['refresh-lists']
    case 'packages':
      return ['install-packages']
    case 'initialize':
      return ['initialize']
    case 'release':
      return ['release']
  }
}
