import { z } from 'zod'
import { ZFS_SPEC } from './spec'

const { defaults } = ZFS_SPEC

/**
 * Pool names must start with a letter, and OpenZFS reserves several prefixes.
 * This is deliberately narrower than what OpenZFS accepts.
 */
const POOL_NAME = /^(?!c[0-9]|mirror|raidz|draid|spare|log)[a-z][a-z0-9_-]{0,31}$/

const onOff = z.enum(['on', 'off'])
const compression = z.enum(['lz4', 'zstd', 'off'])

export const poolNameSchema = z.string().regex(POOL_NAME)

/**
 * Policy selects pool configuration only. It never carries devices, commands,
 * force switches, or authorization.
 */
export const policySchema = z.strictObject({
  poolName: poolNameSchema.default(defaults.poolName),
  arcMaxPercent: z.number().gt(0).lt(100).default(defaults.arcMaxPercent),
  ashift: z.int().min(9).max(16).default(defaults.ashift),
  autotrim: onOff.default(defaults.autotrim),
  compression: compression.default(defaults.compression),
  atime: onOff.default(defaults.atime),
})

export type Policy = z.infer<typeof policySchema>
export const DEFAULT_POLICY: Policy = policySchema.parse({})

/**
 * Identities derived from the protected deployment record, never from the
 * host. `dataBytes` is the planned data volume capacity in bytes.
 */
export interface ZfsTarget {
  instanceId: string
  rootVolumeId: string
  dataVolumeId: string
  dataBytes: number
}

/**
 * The pool that retained evidence expects on the target volume, found through
 * the deployment's own record or its explicit volume-reuse chain. A plan must
 * never contradict it, and `deployment` names the record that holds it.
 * `ready` means this deployment's own evidence shows the pool created or
 * imported and its scrub timer enabled, with no later export.
 */
export interface RecordedPool {
  name: string
  guid: string
  deployment: string
  ready: boolean
}

export interface BlockDevice {
  path: string
  type: string
  sizeBytes: number
  serial: string | null
  model: string | null
  logicalSector: number | null
  physicalSector: number | null
  filesystem: string | null
  mountpoints: string[]
  children: BlockDevice[]
}

const text = z.string().min(1).max(2_048)
const count = z.int().nonnegative()
const guid = z.string().regex(/^[0-9]+$/)

const blockDevice: z.ZodType<BlockDevice> = z.lazy(() =>
  z.strictObject({
    path: text,
    type: text,
    sizeBytes: count,
    serial: text.nullable(),
    model: text.nullable(),
    logicalSector: count.nullable(),
    physicalSector: count.nullable(),
    filesystem: text.nullable(),
    mountpoints: z.array(text).max(64),
    children: z.array(blockDevice).max(64),
  }),
)

const packageChangeSchema = z.strictObject({
  name: text,
  version: text,
  architecture: text,
})

const signatureSchema = z.strictObject({
  path: text,
  exitCode: count,
  fields: z.record(z.string(), z.string()),
})

/**
 * Normalized, bounded evidence from one read-only inspection. A missing
 * prerequisite is a value here (`null` or `false`), never an empty storage
 * result. Pool GUIDs stay decimal strings. `configures` lists packages that
 * APT would configure, which only a half-configured package state produces
 * beyond the new installations. `packages` holds the direct prerequisites plus
 * any approved transaction members that a verification asked about.
 * `pools.detail` describes the one pool the inspection was asked about, and is
 * null when that pool is not imported. Its `data` lists the top-level data
 * vdevs with their type and child count, so a mirror or stripe stays
 * distinguishable from a single disk, `auxiliary` names any log, cache,
 * spare, special, or dedup class that is present, and `mounted` names the
 * datasets that ZFS reports as mounted. `timer` holds the enablement and
 * activation states of that pool's packaged scrub timer, which are reported
 * as observed and are not judged here.
 */
export const observationSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  system: z.strictObject({
    kernel: text,
    architecture: text,
    packageArchitecture: text,
    memoryBytes: z.int().positive(),
    rebootRequired: z.boolean(),
  }),
  module: z
    .strictObject({
      path: text,
      version: text,
      vermagic: text,
      package: text.nullable(),
      loaded: z.boolean(),
    })
    .nullable(),
  packages: z
    .array(
      z.strictObject({
        name: text,
        version: text,
        architecture: text,
        installed: z.boolean(),
      }),
    )
    .max(32),
  transaction: z
    .strictObject({
      installs: z.array(packageChangeSchema).max(64),
      configures: z.array(text).max(256),
      upgrades: z.array(text).max(256),
      removals: z.array(text).max(256),
    })
    .nullable(),
  disks: z.array(blockDevice).max(64),
  signatures: z.array(signatureSchema).max(64),
  arc: z.strictObject({
    ownedLines: z.array(text).max(64).nullable(),
    conflicts: z.array(text).max(64),
    runningMax: count.nullable(),
    runningMin: count.nullable(),
  }),
  pools: z.strictObject({
    tools: z.boolean(),
    moduleLoaded: z.boolean(),
    imported: z
      .array(
        z.strictObject({
          name: text,
          guid,
        }),
      )
      .max(64),
    detail: z
      .strictObject({
        data: z
          .array(
            z.strictObject({
              type: text,
              path: text,
              children: count,
            }),
          )
          .max(64),
        auxiliary: z.array(text).max(16),
        ashifts: z.array(count).max(64),
        mounted: z.array(text).max(64),
        pool: z.record(z.string(), z.string()),
        dataset: z.record(z.string(), z.string()),
      })
      .nullable(),
  }),
  timer: z.strictObject({
    enablement: text,
    activation: text,
  }),
  units: z
    .array(
      z.strictObject({
        name: text,
        state: text,
      }),
    )
    .max(256),
})

export type Observation = z.infer<typeof observationSchema>
export type PackageChange = z.infer<typeof packageChangeSchema>
export type Signature = z.infer<typeof signatureSchema>

export interface RefusedPlan {
  kind: 'refused'
  reasons: string[]
}

export interface RebootPlan {
  kind: 'reboot'
}

/**
 * The pool is imported with its scrub timer enabled and active, and the
 * evidence says so. Nothing is left to apply. This plan is never persisted.
 */
export interface ReadyPlan {
  kind: 'ready'
  pool: string
  guid: string
}

/**
 * Before AWS removal, the recorded pool was freshly observed not imported, and
 * retained evidence already records its verified clean export. The observation
 * only corroborates that evidence, so nothing is applied and no step or
 * evidence is recorded. This plan is never persisted.
 */
export interface AbsentPlan {
  kind: 'absent'
  pool: string
  guid: string
}

/**
 * The ARC percentage and total memory are kept beside the computed limit, so
 * an approval shows exactly how the limit was derived. `expectedPool` is the
 * GUID of a pool that lineage evidence expects on the data volume. Package
 * installation can import pools through package-started units, so the record
 * must be able to tell that an install happened where a pool may exist.
 */
export const prerequisitePlanSchema = z.strictObject({
  kind: z.literal('prerequisites'),
  install: z.array(packageChangeSchema).max(64),
  loadModule: z.boolean(),
  arc: z.strictObject({
    maxBytes: z.int().positive(),
    percent: z.number().gt(0).lt(100),
    memoryBytes: z.int().positive(),
    writeFile: z.boolean(),
    applyRuntime: z.boolean(),
  }),
  expectedPool: guid.nullable(),
})

export const createPlanSchema = z.strictObject({
  kind: z.literal('create'),
  pool: poolNameSchema,
  disk: z.strictObject({
    path: text,
    volumeId: text,
    sizeBytes: count,
    logicalSector: count,
    physicalSector: count,
  }),
  ashift: z.int().min(9).max(16),
  autotrim: onOff,
  dataset: z.strictObject({
    compression,
    atime: onOff,
  }),
  scrubTimer: text,
})

const targetDiskSchema = z.strictObject({
  path: text,
  volumeId: text,
  sizeBytes: count,
})

/**
 * Imports the pool recorded for the volume, by GUID and original name.
 * `imported` records that the pool was already imported when planned, in which
 * case the step is an idempotent confirmation. The parent disk stays the
 * identity authority, while `member` is the one ZFS member partition derived
 * from its inspected children, where whole-disk creation put the pool labels.
 */
export const importPlanSchema = z.strictObject({
  kind: z.literal('import'),
  pool: poolNameSchema,
  guid,
  disk: targetDiskSchema.extend({
    member: text,
  }),
  imported: z.boolean(),
  scrubTimer: text,
})

export const exportPlanSchema = z.strictObject({
  kind: z.literal('export'),
  pool: poolNameSchema,
  guid,
  disk: targetDiskSchema,
  scrubTimer: text,
})

export type PrerequisitePlan = z.infer<typeof prerequisitePlanSchema>
export type CreatePlan = z.infer<typeof createPlanSchema>
export type ImportPlan = z.infer<typeof importPlanSchema>
export type ExportPlan = z.infer<typeof exportPlanSchema>

/**
 * The plans that ask for approval and are persisted with it.
 */
export type ApprovedPlan = PrerequisitePlan | CreatePlan | ImportPlan | ExportPlan

/**
 * What `planOf` can decide.
 */
export type PreparationPlan = RefusedPlan | RebootPlan | ReadyPlan | PrerequisitePlan | CreatePlan | ImportPlan

/**
 * Preparation plans plus what `releasePlanOf` decides, only before AWS removal.
 */
export type Plan = PreparationPlan | ExportPlan | AbsentPlan
