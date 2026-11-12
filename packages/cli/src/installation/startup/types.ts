import { z } from 'zod'
import { INSTALLER_SPEC } from '../spec'
import { authorizationSchemaOf } from '../../journal/history'
import { stepSchemaOf } from '../../journal/step'

/**
 * Declaration order is execution order. `create-admin` runs only when the plan
 * asks for it.
 */
export const STARTUP_ACTIONS = [
  'start-instance',
  'install',
  'build',
  'migrate',
  'grant',
  'create-admin',
  'start-services',
] as const

export type StartupAction = (typeof STARTUP_ACTIONS)[number]
export type UnitAction = Exclude<StartupAction, 'start-instance' | 'start-services'>

/**
 * `admin` says that no first administrator was created by an earlier startup,
 * so the operator is asked for one. The credentials themselves are never
 * evidence.
 */
const planSchema = z.strictObject({
  kind: z.literal('startup'),
  admin: z.boolean(),
})

/**
 * Accounting and recovery evidence for startup, not a resumable checkpoint.
 * Every startup of a stopped instance adds up to seven steps, so the bounds are
 * wider than the configuration evidence. Before the first release, changing any
 * literal or format rule resets local development state.
 */
export const evidenceSchema = z.strictObject({
  version: z.literal(INSTALLER_SPEC.evidenceVersion),
  authorizations: z.array(authorizationSchemaOf(planSchema)).max(64),
  steps: z.array(stepSchemaOf(z.enum(STARTUP_ACTIONS))).max(256),
})

export type StartupPlan = z.infer<typeof planSchema>
export type StartupEvidence = z.infer<typeof evidenceSchema>

export interface Admin {
  username: string
  email: string
  password: string
}

/**
 * The steps one approved plan allows, in the order they run.
 */
export function actionsOf(plan: StartupPlan): readonly StartupAction[] {
  return STARTUP_ACTIONS.filter(action => action !== 'create-admin' || plan.admin)
}
