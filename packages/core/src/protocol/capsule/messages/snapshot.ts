import { z } from 'zod'
import { CapsuleActorReferenceSchema } from '../../../schemas/capsule/actor'
import {
  CapsuleOperationIdempotencyKeySchema,
  CapsuleSnapshotCreateReceiptSchema,
} from '../../../schemas/capsule/operations'
import { CapsuleSnapshotListOutputSchema } from '../../../schemas/capsule/snapshot/record'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from '../definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from '../definitions'

const CAPSULE_SNAPSHOTS_LIST_TIMEOUT_MS = 15_000
const CAPSULE_SNAPSHOT_CREATE_ACCEPTANCE_TIMEOUT_MS = 15_000

export const CapsuleSnapshotCommandName = {
  SNAPSHOTS_LIST: 'capsule.snapshots.list',
  SNAPSHOT_CREATE: 'capsule.snapshot.create',
} as const

export type CapsuleSnapshotCommandName = (typeof CapsuleSnapshotCommandName)[keyof typeof CapsuleSnapshotCommandName]

export const CapsuleSnapshotCommandNameValues = [
  CapsuleSnapshotCommandName.SNAPSHOTS_LIST,
  CapsuleSnapshotCommandName.SNAPSHOT_CREATE,
] as const

/**
 * Owner-scoped committed restoration history.
 *
 * Every returned snapshot must satisfy the same restoration contract. There are
 * no snapshot modes or weaker visibility-dependent evidence requirements.
 */
export const CapsuleSnapshotsListInputSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
  })
  .strict()

export const CapsuleSnapshotsListOutputSchema = CapsuleSnapshotListOutputSchema

export type CapsuleSnapshotsListInput = input<typeof CapsuleSnapshotsListInputSchema>
export type CapsuleSnapshotsList = output<typeof CapsuleSnapshotsListInputSchema>
export type CapsuleSnapshotsListOutput = output<typeof CapsuleSnapshotsListOutputSchema>

/**
 * Accepts Create Snapshot for one exact editable source branch.
 *
 * The trusted authenticated publisher derives actor provenance. The Worker must
 * prove source ownership, offline state, inventory, and restoration pins before
 * durable acceptance. The receipt does not imply snapshot completion.
 */
export const CapsuleSnapshotCreateInputSchema = z
  .object({
    target: TargetOwnerSchema,
    actor: CapsuleActorReferenceSchema,
    capsuleId: z.uuid(),
    sourceBranchId: z.uuid(),
    idempotencyKey: CapsuleOperationIdempotencyKeySchema,
  })
  .strict()

export const CapsuleSnapshotCreateOutputSchema = CapsuleSnapshotCreateReceiptSchema

export type CapsuleSnapshotCreateInput = input<typeof CapsuleSnapshotCreateInputSchema>
export type CapsuleSnapshotCreate = output<typeof CapsuleSnapshotCreateInputSchema>
export type CapsuleSnapshotCreateOutput = output<typeof CapsuleSnapshotCreateOutputSchema>

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
  [CapsuleSnapshotCommandName.SNAPSHOT_CREATE]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleSnapshotCommandName.SNAPSHOT_CREATE,
    inputSchema: CapsuleSnapshotCreateInputSchema,
    outputSchema: CapsuleSnapshotCreateOutputSchema,
    timeoutMs: CAPSULE_SNAPSHOT_CREATE_ACCEPTANCE_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleSnapshotCreate) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleSnapshotCommandName, CapsuleCommandDefinition>
