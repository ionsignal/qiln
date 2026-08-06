import { z } from 'zod'
import { CapsuleActorReferenceSchema, CapsuleActorType } from '../../../schemas/capsule/actor'
import {
  CapsuleOperationIdempotencyKeySchema,
  CapsuleSnapshotCaptureReceiptSchema,
} from '../../../schemas/capsule/operations'
import { CapsuleSnapshotMode } from '../../../schemas/capsule/snapshot/mode'
import {
  CapsuleSnapshotAgentArtifactContentPolicy,
  CapsuleSnapshotAgentArtifactContentPolicySchema,
} from '../../../schemas/capsule/snapshot/read'
import { CapsuleSnapshotListOutputSchema } from '../../../schemas/capsule/snapshot/record'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output, ZodType } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_SNAPSHOTS_LIST_TIMEOUT_MS = 15_000
const CAPSULE_SNAPSHOT_CAPTURE_ACCEPTANCE_TIMEOUT_MS = 15_000

export const CapsuleSnapshotCommandName = {
  SNAPSHOTS_LIST: 'capsule.snapshots.list',
  SNAPSHOT_CAPTURE: 'capsule.snapshot.capture',
} as const

export type CapsuleSnapshotCommandName = (typeof CapsuleSnapshotCommandName)[keyof typeof CapsuleSnapshotCommandName]

export const CapsuleSnapshotCommandNameValues = [
  CapsuleSnapshotCommandName.SNAPSHOTS_LIST,
  CapsuleSnapshotCommandName.SNAPSHOT_CAPTURE,
] as const

/**
 * Owner-scoped committed snapshot history request.
 *
 * Experimental snapshots are excluded unless the authenticated caller
 * explicitly requests them. This flag changes visibility only; it does not
 * weaken committed-operation linkage or ownership checks.
 */
export const CapsuleSnapshotsListInputSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
    includeExperimental: z.boolean().default(false),
  })
  .strict()

export const CapsuleSnapshotsListOutputSchema = CapsuleSnapshotListOutputSchema

export type CapsuleSnapshotsListInput = input<typeof CapsuleSnapshotsListInputSchema>
export type CapsuleSnapshotsList = output<typeof CapsuleSnapshotsListInputSchema>
export type CapsuleSnapshotsListOutput = output<typeof CapsuleSnapshotsListOutputSchema>

/**
 * Accepts an experimental Snapshot Capture operation.
 *
 * The actor is supplied by a trusted authenticated publisher rather than
 * browser input.
 */
export const CapsuleSnapshotCaptureInputSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: CapsuleActorReferenceSchema,
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
    mode: z.literal(CapsuleSnapshotMode.EXPERIMENTAL).default(CapsuleSnapshotMode.EXPERIMENTAL),
    agentArtifactContentPolicy: CapsuleSnapshotAgentArtifactContentPolicySchema.default(
      CapsuleSnapshotAgentArtifactContentPolicy.DENY,
    ),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.agentArtifactContentPolicy === CapsuleSnapshotAgentArtifactContentPolicy.OWNER_AUTHORIZED_UNREVIEWED &&
      (input.actor.type !== CapsuleActorType.USER || input.actor.id !== input.target.id)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['agentArtifactContentPolicy'],
        message: 'Unchecked agent artifact reads may be elected only by the capsule owner user.',
      })
    }
  })

export const CapsuleSnapshotCaptureOutputSchema = CapsuleSnapshotCaptureReceiptSchema

export type CapsuleSnapshotCaptureInput = input<typeof CapsuleSnapshotCaptureInputSchema>
export type CapsuleSnapshotCapture = output<typeof CapsuleSnapshotCaptureInputSchema>
export type CapsuleSnapshotCaptureOutput = output<typeof CapsuleSnapshotCaptureOutputSchema>

export const CapsuleSnapshotEventName = {} as const

export type CapsuleSnapshotEventName = (typeof CapsuleSnapshotEventName)[keyof typeof CapsuleSnapshotEventName]

export const CapsuleSnapshotEventNameValues = [] as const

export const CapsuleSnapshotCommandDefinitions = {
  [CapsuleSnapshotCommandName.SNAPSHOTS_LIST]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSnapshotCommandName.SNAPSHOTS_LIST,
    inputSchema: CapsuleSnapshotsListInputSchema,
    outputSchema: CapsuleSnapshotsListOutputSchema,
    timeoutMs: CAPSULE_SNAPSHOTS_LIST_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSnapshotsList) {
        return payload.target
      },
    },
  }),
  [CapsuleSnapshotCommandName.SNAPSHOT_CAPTURE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSnapshotCommandName.SNAPSHOT_CAPTURE,
    inputSchema: CapsuleSnapshotCaptureInputSchema,
    outputSchema: CapsuleSnapshotCaptureOutputSchema,
    timeoutMs: CAPSULE_SNAPSHOT_CAPTURE_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSnapshotCapture) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleSnapshotCommandName, CapsuleCommandDefinition>

export const CapsuleSnapshotEventDefinitions = {} as const satisfies Record<
  CapsuleSnapshotEventName,
  CapsuleEventDefinition
>

export const CapsuleSnapshotEventSchemas = [] as const satisfies readonly ZodType[]
