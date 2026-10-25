import { z } from 'zod'
import { AWS_RECORD_VERSION } from '../../spec'
import { INCUS_ACTIONS } from '../../../remote/incus/spec'
import {
  initializePlanSchema,
  packagesPlanSchema,
  releasePlanSchema,
  repositoryPlanSchema,
} from '../../../remote/incus/types'
import { bindingSchema } from '../journal/binding'
import { authorizationSchemaOf } from '../journal/history'
import { stepSchemaOf } from '../journal/step'

const stepSchema = stepSchemaOf(z.enum(INCUS_ACTIONS))
const authorizationSchema = authorizationSchemaOf(
  z.discriminatedUnion('kind', [repositoryPlanSchema, packagesPlanSchema, initializePlanSchema, releasePlanSchema]),
)

/**
 * Accounting and recovery evidence for Incus preparation, not a resumable
 * checkpoint. Status is derived from these facts and never stored. The
 * initialize plan keeps the exact approved preseed bytes, which later
 * verification and `ready` read back. Before the first release, changing any
 * literal or format rule resets local development state. After it, a change
 * needs a version bump and a versioned reader.
 */
export const incusSchema = z.strictObject({
  version: z.literal(AWS_RECORD_VERSION.incus),
  binding: bindingSchema,
  authorizations: z.array(authorizationSchema).max(32),
  steps: z.array(stepSchema).max(64),
})

export type IncusRecord = z.infer<typeof incusSchema>
export type IncusStep = IncusRecord['steps'][number]
export type IncusAuthorization = IncusRecord['authorizations'][number]
