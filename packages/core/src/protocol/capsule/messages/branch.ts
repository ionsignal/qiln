import { z } from 'zod'
import {
  CapsuleBlueprintDigestSchema,
  CapsuleBranchIdempotencyKeySchema,
  CapsuleBranchOperationReceiptSchema,
  CapsuleBranchOperationType,
} from '../../../schemas'
import { TargetOwnerSchema, TargetType } from '../targets'
import { CapsuleCommandAckSchema, defineCapsuleCommand, defineCapsuleEvent } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

export const DEFAULT_CAPSULE_BLUEPRINT_NAME = 'n8n-comfyui-capsule'

const CAPSULE_BRANCH_CREATE_TIMEOUT_MS = 180_000
const CAPSULE_BRANCH_DELETE_TIMEOUT_MS = 180_000
const CAPSULE_BRANCH_LIFECYCLE_TIMEOUT_MS = 120_000

/**
 * Branch command names are scoped to the editable capsule branch/fork lifecycle.
 * The aggregate capsule protocol registry re-exports these under `CapsuleCommandName`.
 */
export const CapsuleBranchCommandName = {
  BRANCH_CREATE: 'capsule.branch.create',
  BRANCH_START: 'capsule.branch.start',
  BRANCH_STOP: 'capsule.branch.stop',
  BRANCH_DELETE: 'capsule.branch.delete',
} as const

export type CapsuleBranchCommandName = (typeof CapsuleBranchCommandName)[keyof typeof CapsuleBranchCommandName]

export const CapsuleBranchCommandNameValues = [
  CapsuleBranchCommandName.BRANCH_CREATE,
  CapsuleBranchCommandName.BRANCH_START,
  CapsuleBranchCommandName.BRANCH_STOP,
  CapsuleBranchCommandName.BRANCH_DELETE,
] as const

/**
 * Branch event names are scoped to observable branch runtime state transitions.
 * Durable audit/history semantics should be modeled separately from realtime events.
 */
export const CapsuleBranchEventName = {
  BRANCH_STATE_CHANGED: 'capsule.branch.stateChanged',
  BRANCH_DELETED: 'capsule.branch.deleted',
} as const

export type CapsuleBranchEventName = (typeof CapsuleBranchEventName)[keyof typeof CapsuleBranchEventName]

export const CapsuleBranchEventNameValues = [CapsuleBranchEventName.BRANCH_STATE_CHANGED, CapsuleBranchEventName.BRANCH_DELETED] as const

/**
 * A branch name identifies the editable capsule branch/fork addressed by these
 * operations. It is intentionally not named `CapsuleName`, because the durable
 * capsule object and a capsule branch are separate product concepts.
 */
export const CapsuleBranchNameSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,48}[a-zA-Z0-9])?$/,
    'Capsule branch name must be alphanumeric, can contain hyphens, but cannot start or end with a hyphen.',
  )

/**
 * Single source of truth for all capsule branch runtime states.
 *
 * The Drizzle enum in `@qiln/core/server` imports this tuple so protocol
 * validation and the database read model cannot silently diverge.
 */
export const CapsuleBranchStatusValues = [
  'provisioning',
  'recovering',
  'offline',
  'starting',
  'online',
  'stopping',
  'deleting',
  'archived',
  'error',
  'cleanup_required',
] as const

export const CapsuleBranchStatusSchema = z.enum(CapsuleBranchStatusValues)

export const CapsuleBranchCommandBaseSchema = z
  .object({
    target: TargetOwnerSchema,
    name: CapsuleBranchNameSchema,
  })
  .strict()

/**
 * Create branch command.
 *
 * The blueprint digest pins the exact manifest item reviewed by a user/agent.
 * The idempotency key lets callers safely retry after transport timeouts without
 * accidentally creating a second branch or receiving a misleading duplicate error.
 */
export const CapsuleBranchCreateInputSchema = CapsuleBranchCommandBaseSchema.extend({
  idempotencyKey: CapsuleBranchIdempotencyKeySchema,
  blueprintName: z.string().trim().min(1, 'Capsule blueprint name cannot be empty.').default(DEFAULT_CAPSULE_BLUEPRINT_NAME),
  blueprintDigest: CapsuleBlueprintDigestSchema,
  cpu: z.string().trim().min(1, 'CPU limit cannot be empty.').default('4'),
  memory: z.string().trim().min(1, 'Memory limit cannot be empty.').default('4GB'),
}).strict()

export const CapsuleBranchCreateOutputSchema = CapsuleBranchOperationReceiptSchema.extend({
  operationType: z.literal(CapsuleBranchOperationType.CREATE),
  branchName: CapsuleBranchNameSchema,
  branchStatus: CapsuleBranchStatusSchema,
}).strict()

export type CapsuleBranchCreateInput = input<typeof CapsuleBranchCreateInputSchema>
export type CapsuleBranchCreate = output<typeof CapsuleBranchCreateInputSchema>
export type CapsuleBranchCreateOutput = output<typeof CapsuleBranchCreateOutputSchema>

/**
 * Start branch command.
 */
export const CapsuleBranchStartInputSchema = CapsuleBranchCommandBaseSchema

export type CapsuleBranchStartInput = input<typeof CapsuleBranchStartInputSchema>
export type CapsuleBranchStart = output<typeof CapsuleBranchStartInputSchema>

/**
 * Stop branch command.
 */
export const CapsuleBranchStopInputSchema = CapsuleBranchCommandBaseSchema

export type CapsuleBranchStopInput = input<typeof CapsuleBranchStopInputSchema>
export type CapsuleBranchStop = output<typeof CapsuleBranchStopInputSchema>

/**
 * Delete branch command.
 */
export const CapsuleBranchDeleteInputSchema = CapsuleBranchCommandBaseSchema.extend({
  idempotencyKey: CapsuleBranchIdempotencyKeySchema,
}).strict()

export const CapsuleBranchDeleteOutputSchema = CapsuleBranchOperationReceiptSchema.extend({
  ok: z.literal(true),
  operationType: z.literal(CapsuleBranchOperationType.DELETE),
  branchName: CapsuleBranchNameSchema,
  branchDeleted: z.boolean(),
}).strict()

export type CapsuleBranchDeleteInput = input<typeof CapsuleBranchDeleteInputSchema>
export type CapsuleBranchDelete = output<typeof CapsuleBranchDeleteInputSchema>
export type CapsuleBranchDeleteOutput = output<typeof CapsuleBranchDeleteOutputSchema>

export type CapsuleBranchName = z.infer<typeof CapsuleBranchNameSchema>
export type CapsuleBranchStatus = z.infer<typeof CapsuleBranchStatusSchema>

/**
 * Branch state changed event.
 */
export const CapsuleBranchStateChangedEventSchema = z
  .object({
    type: z.literal(CapsuleBranchEventName.BRANCH_STATE_CHANGED),
    target: TargetOwnerSchema,
    name: CapsuleBranchNameSchema,
    status: CapsuleBranchStatusSchema,
  })
  .strict()

export type CapsuleBranchStateChangedEvent = z.infer<typeof CapsuleBranchStateChangedEventSchema>

/**
 * Branch deleted event.
 */
export const CapsuleBranchDeletedEventSchema = z
  .object({
    type: z.literal(CapsuleBranchEventName.BRANCH_DELETED),
    target: TargetOwnerSchema,
    name: CapsuleBranchNameSchema,
  })
  .strict()

export type CapsuleBranchDeletedEvent = z.infer<typeof CapsuleBranchDeletedEventSchema>

export const CapsuleBranchEventSchemas = [CapsuleBranchStateChangedEventSchema, CapsuleBranchDeletedEventSchema] as const

export const CapsuleBranchCommandDefinitions = {
  [CapsuleBranchCommandName.BRANCH_CREATE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleBranchCommandName.BRANCH_CREATE,
    inputSchema: CapsuleBranchCreateInputSchema,
    outputSchema: CapsuleBranchCreateOutputSchema,
    timeoutMs: CAPSULE_BRANCH_CREATE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleBranchCreate) {
        return payload.target
      },
    },
  }),
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
  [CapsuleBranchCommandName.BRANCH_DELETE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleBranchCommandName.BRANCH_DELETE,
    inputSchema: CapsuleBranchDeleteInputSchema,
    outputSchema: CapsuleBranchDeleteOutputSchema,
    timeoutMs: CAPSULE_BRANCH_DELETE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleBranchDelete) {
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
  [CapsuleBranchEventName.BRANCH_DELETED]: defineCapsuleEvent({
    kind: 'capsule.event',
    name: CapsuleBranchEventName.BRANCH_DELETED,
    schema: CapsuleBranchDeletedEventSchema,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleBranchDeletedEvent) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleBranchEventName, CapsuleEventDefinition>
