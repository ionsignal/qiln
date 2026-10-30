import { z } from 'zod'
import { AWS_RECORD_VERSION } from '../../spec'
import { STEP_ACTIONS, type StepAction } from '../../../host/zfs/spec'
import {
  createPlanSchema,
  exportPlanSchema,
  importPlanSchema,
  mountPlanSchema,
  poolDatasetsSchema,
  poolNameSchema,
  prerequisitePlanSchema,
} from '../../../host/zfs/types'
import { bindingSchema, volumeId } from '../journal/binding'
import { authorizationSchemaOf } from '../../../journal/history'
import { stepSchemaOf, timestamp } from '../../../journal/step'

const authorizationSchema = authorizationSchemaOf(
  z.discriminatedUnion('kind', [
    prerequisitePlanSchema,
    createPlanSchema,
    importPlanSchema,
    mountPlanSchema,
    exportPlanSchema,
  ]),
)

const stepSchema = stepSchemaOf(z.enum(STEP_ACTIONS))

/**
 * The GUID stays a decimal string and is never converted to a number. `layout`
 * is the revision of the dataset arrangement, a literal of the record version,
 * and `datasets` holds the GUIDs of its two datasets once they were verified.
 * `observedAt` is the observation of the verified create or import step and
 * does not move when the datasets are recorded.
 */
const poolSchema = z.strictObject({
  name: poolNameSchema,
  guid: z.string().regex(/^[0-9]+$/),
  volumeId,
  layout: z.literal(1),
  datasets: poolDatasetsSchema.nullable(),
  observedAt: timestamp,
})

/**
 * Accounting and recovery evidence for ZFS preparation, not a resumable
 * checkpoint. Status is derived from these facts and never stored. The version
 * covers every literal and format rule that the guards and the audit consult.
 * Before the first release, changing any of them resets local development
 * state. After it, a change needs a version bump and a versioned reader.
 */
export const zfsSchema = z.strictObject({
  version: z.literal(AWS_RECORD_VERSION.zfs),
  binding: bindingSchema,
  authorizations: z.array(authorizationSchema).max(32),
  steps: z.array(stepSchema).max(64),
  pool: poolSchema.nullable(),
})

export type ZfsRecord = z.infer<typeof zfsSchema>
export type ZfsBinding = ZfsRecord['binding']
export type ZfsStep = ZfsRecord['steps'][number]
export type ZfsAuthorization = ZfsRecord['authorizations'][number]

/**
 * A verified create-pool or import-pool step is what establishes the pool
 * evidence of a record.
 */
export function establishesPool(action: StepAction): boolean {
  return action === 'create-pool' || action === 'import-pool'
}

/**
 * The steps one approved plan allows. A step whose action is not listed here
 * was never authorized, however plausible it looks.
 */
export function actionsOf(plan: ZfsAuthorization['plan']): readonly StepAction[] {
  switch (plan.kind) {
    case 'prerequisites': {
      const actions: StepAction[] = []
      if (plan.install.length > 0) {
        actions.push('install-packages')
      }
      if (plan.arc.writeFile) {
        actions.push('write-arc')
      }
      if (plan.loadModule) {
        actions.push('load-module')
      }
      if (plan.arc.applyRuntime) {
        actions.push('apply-arc')
      }
      return actions
    }
    case 'create':
      return ['create-pool', 'create-datasets', 'enable-scrub']
    case 'import':
      return ['import-pool', 'enable-scrub']
    case 'mount':
      return ['mount-state']
    case 'export':
      return plan.unmount ? ['unmount-state', 'export-pool'] : ['export-pool']
  }
}

/**
 * The pool that a plan would create or import, or null for a plan that
 * establishes none.
 */
export function poolNameOf(plan: ZfsAuthorization['plan']): string | null {
  return plan.kind === 'create' || plan.kind === 'import' ? plan.pool : null
}
