import { z } from 'zod'
import { authorizationSchemaOf } from '../../journal/history'
import { operationId, stepSchemaOf } from '../../journal/step'
import { hostSchema } from '../records'
import { INSTALLER_SPEC } from '../spec'

/**
 * Incus-side effects only. Pin and credential writes are not journaled: each is
 * an atomic record or file transition, covered by the approval that shows it.
 */
export const INSTALL_ACTIONS = [
  'delete-image',
  'import-image',
  'create-alias',
  'create-network',
  'create-volume',
  'create-instance',
  'update-instance',
] as const

export type InstallAction = (typeof INSTALL_ACTIONS)[number]

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const text = z.string().min(1).max(256)

/**
 * The complete configuration change as the operator approved it. Each flag is a
 * decision made from one observation, so an empty plan shows that nothing is
 * left to apply. `image.replace` names the previous managed target and every
 * alias attached to it, which is the only destructive step.
 */
export const planSchema = z.strictObject({
  kind: z.literal('configure'),
  fingerprint: sha256,
  image: z.strictObject({
    replace: z.strictObject({ fingerprint: sha256, aliases: z.array(text).max(16) }).nullable(),
    import: z.boolean(),
    alias: z.boolean(),
  }),
  pin: z.boolean(),
  network: z.boolean(),
  volume: z.boolean(),
  instance: z.boolean(),
  credentials: z.enum(['generate', 'roster', 'reuse']),
  deliver: z.boolean(),
})

export type ConfigurePlan = z.infer<typeof planSchema>

const authorizationSchema = authorizationSchemaOf(planSchema)
const stepSchema = stepSchemaOf(z.enum(INSTALL_ACTIONS))

/**
 * An asynchronous Incus operation reference. It is recorded before its wait
 * begins, so an interrupted wait remains visible as evidence.
 */
const operationSchema = z.strictObject({
  step: operationId,
  id: operationId,
  path: z.string().regex(/^\/1\.0\/operations\/[0-9a-f-]{36}$/),
})

/**
 * Accounting and recovery evidence for configuration, not a resumable
 * checkpoint. The binding names the host the evidence belongs to. Before the
 * first release, changing any literal or format rule resets local development
 * state. After it, a change needs a version bump and a versioned reader.
 */
export const evidenceSchema = z.strictObject({
  version: z.literal(INSTALLER_SPEC.evidenceVersion),
  binding: z.strictObject({ host: hostSchema }),
  authorizations: z.array(authorizationSchema).max(32),
  steps: z.array(stepSchema).max(64),
  operations: z.array(operationSchema).max(64),
})

export type ConfigureEvidence = z.infer<typeof evidenceSchema>
export type ConfigureAuthorization = ConfigureEvidence['authorizations'][number]
export type ConfigureStep = ConfigureEvidence['steps'][number]
export type ConfigureOperation = ConfigureEvidence['operations'][number]

/**
 * The Incus-side steps one approved plan allows, in the order they run. A step
 * whose action is not listed here was never authorized.
 */
export function actionsOf(plan: ConfigurePlan): readonly InstallAction[] {
  const actions: InstallAction[] = []
  if (plan.image.replace !== null) {
    actions.push('delete-image')
  }
  if (plan.image.import) {
    actions.push('import-image')
  }
  if (plan.image.alias) {
    actions.push('create-alias')
  }
  if (plan.network) {
    actions.push('create-network')
  }
  if (plan.volume) {
    actions.push('create-volume')
  }
  if (plan.instance) {
    actions.push('create-instance')
  }
  if (plan.deliver) {
    actions.push('update-instance')
  }
  return actions
}

/**
 * A plan that changes nothing needs no approval and no terminal, so an
 * installation that already matches its evidence never prompts.
 */
export function isEmpty(plan: ConfigurePlan): boolean {
  return actionsOf(plan).length === 0 && !plan.pin && plan.credentials === 'reuse'
}
