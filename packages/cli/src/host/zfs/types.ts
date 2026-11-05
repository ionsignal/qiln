import { z } from 'zod'
import { ZFS_SPEC } from './spec'
import { mountSchema } from '../mount'

const { defaults } = ZFS_SPEC
const POOL_NAME = /^(?!c[0-9]|mirror|raidz|draid|spare|log)[a-z][a-z0-9_-]{0,31}$/
const onOff = z.enum(['on', 'off'])
const compression = z.enum(['lz4', 'zstd', 'off'])

export const poolNameSchema = z.string().regex(POOL_NAME)
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
 * `datasets` are the GUIDs of its three datasets, null while none was verified.
 * `staged` means this deployment's own evidence shows the pool created or
 * imported, its datasets verified, and its scrub timer enabled, with no later
 * unmount or export. `ready` additionally means the state dataset was mounted.
 */
export interface RecordedPool {
  name: string
  guid: string
  datasets: PoolDatasets | null
  deployment: string
  staged: boolean
  ready: boolean
}

export interface PoolIdentity {
  guid: string
  datasets: PoolDatasets | null
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

export const poolDatasetsSchema = z.strictObject({
  state: guid,
  incus: guid,
  artifacts: guid,
})

export type PoolDatasets = z.infer<typeof poolDatasetsSchema>

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

const propertySchema = z.strictObject({
  value: text,
  source: text,
})

export const datasetSchema = z.strictObject({
  name: text,
  guid,
  type: text,
  mountpoint: propertySchema,
  canmount: propertySchema,
  mounted: z.boolean(),
})

export type Dataset = z.infer<typeof datasetSchema>

/**
 * Normalized, bounded evidence from one read-only inspection. A missing
 * prerequisite is a value (`null` or `false`), never an empty storage result,
 * and pool GUIDs stay decimal strings. `configures` lists packages that APT
 * would configure beyond the new installations, which only a half-configured
 * package state produces. `pools.detail` describes the one pool the inspection
 * was asked about, or null when it is not imported: `data` lists the top-level
 * data vdevs so a mirror or stripe stays distinguishable from a single disk,
 * `auxiliary` names any log, cache, spare, special, or dedup class, `mounted`
 * names the datasets ZFS reports mounted, and `topLevel` describes the pool
 * dataset and its direct children. `timer` reports the scrub timer's
 * enablement and activation as observed. `stateMount` is the kernel
 * mount-table entry at the Incus state directory, or null when none was
 * reported.
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
        topLevel: z.array(datasetSchema).max(64),
        pool: z.record(z.string(), z.string()),
        dataset: z.record(z.string(), z.string()),
      })
      .nullable(),
  }),
  timer: z.strictObject({
    enablement: text,
    activation: text,
  }),
  stateMount: mountSchema.nullable(),
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
 * The pool is imported with its scrub timer enabled and active and its state
 * dataset mounted, and the evidence says so. Never persisted.
 */
export interface ReadyPlan {
  kind: 'ready'
  pool: string
  guid: string
}

/**
 * Before AWS removal, the recorded pool was freshly observed not imported, and
 * retained evidence already records its verified clean export. The observation
 * only corroborates that evidence, so nothing is applied or recorded. Never
 * persisted.
 */
export interface AbsentPlan {
  kind: 'absent'
  pool: string
  guid: string
}

/**
 * The ARC percentage and total memory are kept beside the computed limit, so
 * an approval shows how the limit was derived. `expectedPool` is the GUID of a
 * pool that lineage evidence expects on the data volume: package installation
 * can import pools through package-started units, so the record must be able
 * to tell that an install happened where a pool may exist.
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

/**
 * Creates the pool and its three datasets, enables the scrub timer, and mounts
 * the state dataset. ZFS assigns the GUIDs, so they are learned from the
 * verified dataset step, and the mount takes them from the journal record.
 */
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
 * Imports the pool recorded for the volume, by GUID and original name, enables
 * its scrub timer, and mounts its state dataset. `datasets` are the recorded
 * dataset GUIDs, which the pool must hold exactly. A null value means the pool
 * was recorded before its datasets were verified, for example after an
 * interrupted creation: the pool must then hold only its root dataset, and the
 * plan creates the three datasets after the import. `imported` records that the
 * pool was already imported when planned, so the import step is an idempotent
 * confirmation. `mountOnly` records that the pool was already staged, so only
 * the mount remains. The parent disk stays the identity authority, while
 * `member` is the one ZFS member partition where whole-disk creation put the
 * pool labels.
 */
export const importPlanSchema = z.strictObject({
  kind: z.literal('import'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema.nullable(),
  disk: targetDiskSchema.extend({
    member: text,
  }),
  imported: z.boolean(),
  mountOnly: z.boolean(),
  scrubTimer: text,
})

/**
 * Exports the pool, after unmounting the state dataset when `unmount` is set.
 * Any other mounted dataset refuses the plan.
 */
export const exportPlanSchema = z.strictObject({
  kind: z.literal('export'),
  pool: poolNameSchema,
  guid,
  datasets: poolDatasetsSchema,
  unmount: z.boolean(),
  disk: targetDiskSchema,
  scrubTimer: text,
})

export type PrerequisitePlan = z.infer<typeof prerequisitePlanSchema>
export type CreatePlan = z.infer<typeof createPlanSchema>
export type ImportPlan = z.infer<typeof importPlanSchema>
export type ExportPlan = z.infer<typeof exportPlanSchema>

export type ApprovedPlan = PrerequisitePlan | CreatePlan | ImportPlan | ExportPlan
export type PreparationPlan = RefusedPlan | RebootPlan | ReadyPlan | PrerequisitePlan | CreatePlan | ImportPlan
export type Plan = PreparationPlan | ExportPlan | AbsentPlan

export function createsDatasets(plan: ApprovedPlan): plan is CreatePlan | (ImportPlan & { datasets: null }) {
  return plan.kind === 'create' || (plan.kind === 'import' && plan.datasets === null)
}
