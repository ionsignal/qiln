import { z } from 'zod'
import { CapsuleSnapshotListOutputSchema } from '../../../schemas/capsule/snapshots'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output, ZodType } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_SNAPSHOTS_LIST_TIMEOUT_MS = 15_000

/**
 * Snapshot commands currently expose only committed logical snapshot history.
 * Capture, archive, restore, deletion, diff, and physical snapshot mutation are
 * intentionally absent until Qiln can prove complete artifact manifests.
 */
export const CapsuleSnapshotCommandName = {
  SNAPSHOTS_LIST: 'capsule.snapshots.list',
} as const

export type CapsuleSnapshotCommandName = (typeof CapsuleSnapshotCommandName)[keyof typeof CapsuleSnapshotCommandName]

export const CapsuleSnapshotCommandNameValues = [CapsuleSnapshotCommandName.SNAPSHOTS_LIST] as const

/**
 * Common owner-scoped snapshot command identity.
 *
 * The owner target is the routing and authorization scope. `capsuleId`
 * identifies the requested capsule but n ever replaces independent durable
 * ownership verification.
 */
export const CapsuleSnapshotOwnerScopedInputSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
  })
  .strict()

export const CapsuleSnapshotsListInputSchema = CapsuleSnapshotOwnerScopedInputSchema
export const CapsuleSnapshotsListOutputSchema = CapsuleSnapshotListOutputSchema

export type CapsuleSnapshotsListInput = input<typeof CapsuleSnapshotsListInputSchema>
export type CapsuleSnapshotsList = output<typeof CapsuleSnapshotsListInputSchema>
export type CapsuleSnapshotsListOutput = output<typeof CapsuleSnapshotsListOutputSchema>

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
} as const satisfies Record<CapsuleSnapshotCommandName, CapsuleCommandDefinition>

export const CapsuleSnapshotEventDefinitions = {} as const satisfies Record<
  CapsuleSnapshotEventName,
  CapsuleEventDefinition
>

export const CapsuleSnapshotEventSchemas = [] as const satisfies readonly ZodType[]
