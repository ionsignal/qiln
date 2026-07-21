import { z } from 'zod'
import {
  CapsuleBranchNameSchema,
  CapsuleBranchStatusSchema,
  type CapsuleBranchName,
  type CapsuleBranchStatus,
} from '../../../schemas/capsule/branch'
import { TargetOwnerSchema, TargetType } from '../targets'
import { CapsuleCommandAckSchema, defineCapsuleCommand, defineCapsuleEvent } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_BRANCH_LIFECYCLE_TIMEOUT_MS = 120_000

/**
 * Branch commands currently expose only runtime start and stop. The root branch
 * cannot be directly deleted. Capsule destroy governs terminal retirement of
 * the initial capsule lineage.
 */
export const CapsuleBranchCommandName = {
  BRANCH_START: 'capsule.branch.start',
  BRANCH_STOP: 'capsule.branch.stop',
} as const

export type CapsuleBranchCommandName = (typeof CapsuleBranchCommandName)[keyof typeof CapsuleBranchCommandName]

export const CapsuleBranchCommandNameValues = [CapsuleBranchCommandName.BRANCH_START, CapsuleBranchCommandName.BRANCH_STOP] as const

export const CapsuleBranchEventName = {
  BRANCH_STATE_CHANGED: 'capsule.branch.stateChanged',
} as const

export type CapsuleBranchEventName = (typeof CapsuleBranchEventName)[keyof typeof CapsuleBranchEventName]

export const CapsuleBranchEventNameValues = [CapsuleBranchEventName.BRANCH_STATE_CHANGED] as const

export { CapsuleBranchNameSchema, CapsuleBranchStatusSchema }
export type { CapsuleBranchName, CapsuleBranchStatus }

export const CapsuleBranchCommandBaseSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
    name: CapsuleBranchNameSchema,
  })
  .strict()

export const CapsuleBranchStartInputSchema = CapsuleBranchCommandBaseSchema

export type CapsuleBranchStartInput = input<typeof CapsuleBranchStartInputSchema>
export type CapsuleBranchStart = output<typeof CapsuleBranchStartInputSchema>

export const CapsuleBranchStopInputSchema = CapsuleBranchCommandBaseSchema

export type CapsuleBranchStopInput = input<typeof CapsuleBranchStopInputSchema>
export type CapsuleBranchStop = output<typeof CapsuleBranchStopInputSchema>

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
    outputSchema: CapsuleCommandAckSchema,
    timeoutMs: CAPSULE_BRANCH_LIFECYCLE_TIMEOUT_MS,
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
    outputSchema: CapsuleCommandAckSchema,
    timeoutMs: CAPSULE_BRANCH_LIFECYCLE_TIMEOUT_MS,
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
