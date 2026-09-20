import { z } from 'zod'
import { CapsuleDetailSchema, CapsuleListOutputSchema } from '../../../schemas/capsule/read'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from '../definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from '../definitions'

const CAPSULE_READ_TIMEOUT_MS = 15_000

/**
 * Worker-authoritative capsule projections from durable lifecycle, branch,
 * operation, preview, and historical provenance evidence.
 *
 * The authenticated publisher derives the owner target. Payload validation
 * checks contract shape, not publisher identity or resource authorization.
 */
export const CapsuleReadCommandName = {
  CAPSULE_LIST: 'capsule.list',
  CAPSULE_DETAIL: 'capsule.detail',
} as const

export type CapsuleReadCommandName = (typeof CapsuleReadCommandName)[keyof typeof CapsuleReadCommandName]

export const CapsuleReadCommandNameValues = [
  CapsuleReadCommandName.CAPSULE_LIST,
  CapsuleReadCommandName.CAPSULE_DETAIL,
] as const

/**
 * Returns every owned capsule, including archived and destroyed capsules.
 *
 * The demo contract is deliberately unpaginated and must not silently truncate
 * results or omit capsules based on root-branch runtime state.
 */
export const CapsuleListInputSchema = z
  .object({
    target: TargetOwnerSchema,
  })
  .strict()

export const CapsuleListCommandOutputSchema = CapsuleListOutputSchema

export type CapsuleListInput = input<typeof CapsuleListInputSchema>
export type CapsuleList = output<typeof CapsuleListInputSchema>
export type CapsuleListCommandOutput = output<typeof CapsuleListCommandOutputSchema>

/**
 * Omitting branchId selects the capsule root branch. An explicit selector must
 * resolve within the owned capsule or fail; it never authorizes root fallback.
 */
export const CapsuleDetailInputSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
    branchId: z.uuid().optional(),
  })
  .strict()

export const CapsuleDetailOutputSchema = CapsuleDetailSchema

export type CapsuleDetailInput = input<typeof CapsuleDetailInputSchema>
export type CapsuleDetailRequest = output<typeof CapsuleDetailInputSchema>
export type CapsuleDetailOutput = output<typeof CapsuleDetailOutputSchema>

export const CapsuleReadCommandDefinitions = {
  [CapsuleReadCommandName.CAPSULE_LIST]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleReadCommandName.CAPSULE_LIST,
    inputSchema: CapsuleListInputSchema,
    outputSchema: CapsuleListCommandOutputSchema,
    timeoutMs: CAPSULE_READ_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleList) {
        return payload.target
      },
    },
  }),
  [CapsuleReadCommandName.CAPSULE_DETAIL]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleReadCommandName.CAPSULE_DETAIL,
    inputSchema: CapsuleDetailInputSchema,
    outputSchema: CapsuleDetailOutputSchema,
    timeoutMs: CAPSULE_READ_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsuleDetailRequest) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleReadCommandName, CapsuleCommandDefinition>
