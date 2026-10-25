import { z } from 'zod'
import { AWS_RECORD_VERSION } from '../../spec'
import { INCUS_ACTIONS } from '../../../remote/incus/spec'
import {
  accessPlanSchema,
  initializePlanSchema,
  packagesPlanSchema,
  releasePlanSchema,
  repositoryPlanSchema,
} from '../../../remote/incus/types'
import { bindingSchema } from '../journal/binding'
import { authorizationSchemaOf } from '../journal/history'
import { stepSchemaOf, timestamp } from '../journal/step'

const stepSchema = stepSchemaOf(z.enum(INCUS_ACTIONS))
const authorizationSchema = authorizationSchemaOf(
  z.discriminatedUnion('kind', [
    repositoryPlanSchema,
    packagesPlanSchema,
    initializePlanSchema,
    accessPlanSchema,
    releasePlanSchema,
  ]),
)

/**
 * The latest fresh observation that every Incus unit was inactive. It is not a
 * step: nothing was executed, so it has no authorization, fence, or exit code.
 */
const quiescenceSchema = z.strictObject({
  observedAt: timestamp,
})

/**
 * Accounting and recovery evidence for Incus preparation, not a resumable
 * checkpoint. Status is derived from these facts and never stored. The
 * initialize plan keeps the exact approved preseed bytes, which later
 * verification and `ready` read back. `quiescence` is point-in-time evidence
 * of an observed stop and never settles an unresolved step. Before the first
 * release, changing any literal or format rule resets local development state.
 * After it, a change needs a version bump and a versioned reader.
 */
export const incusSchema = z.strictObject({
  version: z.literal(AWS_RECORD_VERSION.incus),
  binding: bindingSchema,
  authorizations: z.array(authorizationSchema).max(32),
  steps: z.array(stepSchema).max(64),
  quiescence: quiescenceSchema.nullable(),
})

export type IncusRecord = z.infer<typeof incusSchema>
export type IncusStep = IncusRecord['steps'][number]
export type IncusAuthorization = IncusRecord['authorizations'][number]
