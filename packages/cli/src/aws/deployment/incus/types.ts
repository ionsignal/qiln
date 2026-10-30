import { z } from 'zod'
import { AWS_RECORD_VERSION } from '../../spec'
import { baselineSchema } from '../../../host/incus/baseline'
import { INCUS_ACTIONS } from '../../../host/incus/spec'
import {
  accessPlanSchema,
  closePlanSchema,
  guardPlanSchema,
  identitySchema,
  initializePlanSchema,
  openPlanSchema,
  packagesPlanSchema,
  releasePlanSchema,
  repositoryPlanSchema,
} from '../../../host/incus/types'
import { bindingSchema } from '../journal/binding'
import { authorizationSchemaOf } from '../../../journal/history'
import { stepSchemaOf } from '../../../journal/step'

const stepSchema = stepSchemaOf(z.enum(INCUS_ACTIONS))
const authorizationSchema = authorizationSchemaOf(
  z.discriminatedUnion('kind', [
    closePlanSchema,
    guardPlanSchema,
    repositoryPlanSchema,
    packagesPlanSchema,
    openPlanSchema,
    initializePlanSchema,
    accessPlanSchema,
    releasePlanSchema,
  ]),
)

/**
 * Accounting and recovery evidence for Incus preparation, not a resumable
 * checkpoint. Status is derived from these facts and never stored. The
 * initialize plan keeps the exact approved preseed bytes, which later
 * verification and `ready` read back. `baseline` is the installed software and
 * the root subordinate-ID ranges that the initialization was verified against,
 * and `identity` is the standalone server it was verified on. Both are set once,
 * together, in the write that verifies that step. Whether Incus was released is
 * derived from the steps: a verified `release` step after the last open or
 * initialization that was not refused. Before the first release, changing any
 * literal or format rule resets local development state. After it, a change
 * needs a version bump and a versioned reader.
 */
export const incusSchema = z.strictObject({
  version: z.literal(AWS_RECORD_VERSION.incus),
  binding: bindingSchema,
  authorizations: z.array(authorizationSchema).max(32),
  steps: z.array(stepSchema).max(64),
  baseline: baselineSchema.nullable(),
  identity: identitySchema.nullable(),
})

export type IncusRecord = z.infer<typeof incusSchema>
export type IncusStep = IncusRecord['steps'][number]
export type IncusAuthorization = IncusRecord['authorizations'][number]
