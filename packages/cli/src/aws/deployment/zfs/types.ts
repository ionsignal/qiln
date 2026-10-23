import { z } from 'zod'
import { KIND_IDS } from '../graph'
import { AWS_RECORD_VERSION } from '../../spec'
import { STEP_ACTIONS, type StepAction } from '../../../remote/zfs/spec'
import { isIdentity, isOperationId, isTimestamp, validName, validRegion, type AwsIdentity } from '../../types'
import {
  createPlanSchema,
  exportPlanSchema,
  importPlanSchema,
  poolNameSchema,
  prerequisitePlanSchema,
} from '../../../remote/zfs/types'

const operationId = z.string().refine(isOperationId, 'Expected an operation ID.')
const timestamp = z.string().refine(isTimestamp, 'Expected a canonical timestamp.')
const volumeId = z.string().regex(KIND_IDS.volume)

/**
 * The deployment this evidence belongs to. It is compared with the deployment
 * record on every read, so evidence can never be applied to another host.
 */
const bindingSchema = z.strictObject({
  deployment: operationId,
  connection: z.string().refine(validName, 'Expected a connection name.'),
  operator: z.custom<AwsIdentity>(isIdentity),
  region: z.string().refine(validRegion, 'Expected a region.'),
  instanceId: z.string().regex(KIND_IDS.instance),
  rootVolumeId: volumeId,
  dataVolumeId: volumeId,
})

/**
 * One approved plan. The approver is the trusted local invocation identity, not
 * the AWS operator, because a retained SSH pin involves no fresh AWS
 * authentication. The recipe identifies the exact scripts that were approved.
 */
const authorizationSchema = z.strictObject({
  id: operationId,
  approvedAt: timestamp,
  approvedBy: z.strictObject({
    method: z.literal('local-interactive'),
    userId: z.int().nonnegative(),
  }),
  recipe: z.strictObject({
    revision: z.int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  plan: z.discriminatedUnion('kind', [prerequisitePlanSchema, createPlanSchema, importPlanSchema, exportPlanSchema]),
})

/**
 * One fenced remote effect. A refusal is a definite absence of effect, so it
 * never coexists with a completion. A completion with a nonzero exit code does
 * not establish that nothing changed, and a zero exit code is not verified
 * until `verifiedAt` is set. Timestamps never precede the event they follow.
 */
const stepSchema = z
  .strictObject({
    id: operationId,
    authorization: operationId,
    action: z.enum(STEP_ACTIONS),
    fencedAt: timestamp,
    completion: z
      .strictObject({
        exitCode: z.int().min(0).max(255),
        completedAt: timestamp,
      })
      .nullable(),
    refusedAt: timestamp.nullable(),
    verifiedAt: timestamp.nullable(),
  })
  .refine(({ completion, refusedAt }) => refusedAt === null || completion === null, 'Expected a refusal or a completion, not both.')
  .refine(
    ({ completion, verifiedAt }) => verifiedAt === null || completion?.exitCode === 0,
    'Expected verification only after a zero exit.',
  )
  .refine(
    ({ fencedAt, completion, refusedAt, verifiedAt }) =>
      (completion === null || completion.completedAt >= fencedAt) &&
      (refusedAt === null || refusedAt >= fencedAt) &&
      (verifiedAt === null || (completion !== null && verifiedAt >= completion.completedAt)),
    'Expected chronological step timestamps.',
  )

/**
 * The GUID stays a decimal string and is never converted to a number.
 */
const poolSchema = z.strictObject({
  name: poolNameSchema,
  guid: z.string().regex(/^[0-9]+$/),
  volumeId,
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
      return ['create-pool', 'enable-scrub']
    case 'import':
      return ['import-pool', 'enable-scrub']
    case 'export':
      return ['export-pool']
  }
}

/**
 * The pool that a plan would create or import, or null for a plan that
 * establishes none.
 */
export function poolNameOf(plan: ZfsAuthorization['plan']): string | null {
  return plan.kind === 'create' || plan.kind === 'import' ? plan.pool : null
}
