import { z } from 'zod'
import { CapsuleActorReferenceSchema } from '../../../schemas/capsule/actor'
import {
  CapsuleBranchNameSchema,
  CapsuleBranchStatusSchema,
  type CapsuleBranchName,
  type CapsuleBranchStatus,
} from '../../../schemas/capsule/branch'
import {
  CapsuleBranchStartReceiptSchema,
  CapsuleBranchStopReceiptSchema,
  CapsuleOperationIdempotencyKeySchema,
} from '../../../schemas/capsule/operations'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand, defineCapsuleEvent } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_BRANCH_ACCEPTANCE_TIMEOUT_MS = 15_000

/**
 * Branch commands expose durable runtime start and stop submission. The root
 * branch cannot be directly deleted. Capsule destroy governs terminal
 * retirement of the initial capsule lineage.
 *
 * Receipts prove acceptance or replay, not completed runtime coordination.
 */
export const CapsuleBranchCommandName = {
  BRANCH_START: 'capsule.branch.start',
  BRANCH_STOP: 'capsule.branch.stop',
} as const

export type CapsuleBranchCommandName = (typeof CapsuleBranchCommandName)[keyof typeof CapsuleBranchCommandName]

export const CapsuleBranchCommandNameValues = [
  CapsuleBranchCommandName.BRANCH_START,
  CapsuleBranchCommandName.BRANCH_STOP,
] as const

export const CapsuleBranchEventName = {
  BRANCH_STATE_CHANGED: 'capsule.branch.stateChanged',
} as const

export type CapsuleBranchEventName = (typeof CapsuleBranchEventName)[keyof typeof CapsuleBranchEventName]

export const CapsuleBranchEventNameValues = [CapsuleBranchEventName.BRANCH_STATE_CHANGED] as const

export { CapsuleBranchNameSchema, CapsuleBranchStatusSchema }
export type { CapsuleBranchName, CapsuleBranchStatus }

/**
 * Exact owner-scoped branch mutation identity.
 *
 * Actor provenance must come from the authenticated publisher. The Worker
 * persists the supplied idempotency key and resolves the branch by UUID rather
 * than treating its mutable user-facing name as execution authority.
 */
export const CapsuleBranchCommandBaseSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: CapsuleActorReferenceSchema,
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

export const CapsuleBranchStartInputSchema = CapsuleBranchCommandBaseSchema
export const CapsuleBranchStartOutputSchema = CapsuleBranchStartReceiptSchema

export type CapsuleBranchStartInput = input<typeof CapsuleBranchStartInputSchema>
export type CapsuleBranchStart = output<typeof CapsuleBranchStartInputSchema>
export type CapsuleBranchStartOutput = output<typeof CapsuleBranchStartOutputSchema>

export const CapsuleBranchStopInputSchema = CapsuleBranchCommandBaseSchema
export const CapsuleBranchStopOutputSchema = CapsuleBranchStopReceiptSchema

export type CapsuleBranchStopInput = input<typeof CapsuleBranchStopInputSchema>
export type CapsuleBranchStop = output<typeof CapsuleBranchStopInputSchema>
export type CapsuleBranchStopOutput = output<typeof CapsuleBranchStopOutputSchema>

export const CapsuleBranchStateChangedEventSchema = z
  .object({
    type: z.literal(CapsuleBranchEventName.BRANCH_STATE_CHANGED),
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
    name: CapsuleBranchNameSchema,
    status: CapsuleBranchStatusSchema,
  })
  .strict()

export type CapsuleBranchStateChangedEvent = z.infer<typeof CapsuleBranchStateChangedEventSchema>

export const CapsuleBranchEventSchemas = [CapsuleBranchStateChangedEventSchema] as const

export const CapsuleBranchCommandDefinitions = {
  [CapsuleBranchCommandName.BRANCH_START]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleBranchCommandName.BRANCH_START,
    inputSchema: CapsuleBranchStartInputSchema,
    outputSchema: CapsuleBranchStartOutputSchema,
    timeoutMs: CAPSULE_BRANCH_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleBranchStart) {
        return payload.target
      },
    },
  }),
  [CapsuleBranchCommandName.BRANCH_STOP]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleBranchCommandName.BRANCH_STOP,
    inputSchema: CapsuleBranchStopInputSchema,
    outputSchema: CapsuleBranchStopOutputSchema,
    timeoutMs: CAPSULE_BRANCH_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleBranchStop) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleBranchCommandName, CapsuleCommandDefinition>

export const CapsuleBranchEventDefinitions = {
  [CapsuleBranchEventName.BRANCH_STATE_CHANGED]: defineCapsuleEvent({
    kind: 'capsule.event',
    name: CapsuleBranchEventName.BRANCH_STATE_CHANGED,
    schema: CapsuleBranchStateChangedEventSchema,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleBranchStateChangedEvent) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleBranchEventName, CapsuleEventDefinition>
