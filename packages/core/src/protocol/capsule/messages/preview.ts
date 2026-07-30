import { z } from 'zod'
import { CapsuleBlueprintIdentifierSchema } from '../../../schemas/blueprint/provision'
import {
  CapsuleBranchPreviewListOutputSchema,
  CapsuleBranchPreviewStatusSchema,
} from '../../../schemas/capsule/routing'
import { TargetOwnerSchema, TargetType } from '../targets'
import { defineCapsuleCommand, defineCapsuleEvent } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

const CAPSULE_PREVIEWS_LIST_TIMEOUT_MS = 15_000

export const CapsulePreviewCommandName = {
  PREVIEWS_LIST: 'capsule.previews.list',
} as const

export type CapsulePreviewCommandName = (typeof CapsulePreviewCommandName)[keyof typeof CapsulePreviewCommandName]

export const CapsulePreviewCommandNameValues = [CapsulePreviewCommandName.PREVIEWS_LIST] as const

export const CapsulePreviewEventName = {
  PREVIEW_CHANGED: 'capsule.preview.changed',
} as const

export type CapsulePreviewEventName = (typeof CapsulePreviewEventName)[keyof typeof CapsulePreviewEventName]

export const CapsulePreviewEventNameValues = [CapsulePreviewEventName.PREVIEW_CHANGED] as const

export const CapsulePreviewsListInputSchema = z
  .object({
    target: TargetOwnerSchema,
    capsuleId: z.uuid(),
  })
  .strict()

export const CapsulePreviewsListOutputSchema = CapsuleBranchPreviewListOutputSchema

export type CapsulePreviewsListInput = input<typeof CapsulePreviewsListInputSchema>
export type CapsulePreviewsList = output<typeof CapsulePreviewsListInputSchema>
export type CapsulePreviewsListOutput = output<typeof CapsulePreviewsListOutputSchema>

export const CapsulePreviewChangedEventSchema = z
  .object({
    type: z.literal(CapsulePreviewEventName.PREVIEW_CHANGED),
    target: TargetOwnerSchema,
    previewId: z.uuid(),
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    applicationName: CapsuleBlueprintIdentifierSchema,
    status: CapsuleBranchPreviewStatusSchema,
  })
  .strict()

export type CapsulePreviewChangedEvent = z.infer<typeof CapsulePreviewChangedEventSchema>

export const CapsulePreviewEventSchemas = [CapsulePreviewChangedEventSchema] as const

export const CapsulePreviewCommandDefinitions = {
  [CapsulePreviewCommandName.PREVIEWS_LIST]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsulePreviewCommandName.PREVIEWS_LIST,
    inputSchema: CapsulePreviewsListInputSchema,
    outputSchema: CapsulePreviewsListOutputSchema,
    timeoutMs: CAPSULE_PREVIEWS_LIST_TIMEOUT_MS,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsulePreviewsList) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsulePreviewCommandName, CapsuleCommandDefinition>

export const CapsulePreviewEventDefinitions = {
  [CapsulePreviewEventName.PREVIEW_CHANGED]: defineCapsuleEvent({
    kind: 'capsule.event',
    name: CapsulePreviewEventName.PREVIEW_CHANGED,
    schema: CapsulePreviewChangedEventSchema,
    target: {
      type: TargetType.OWNER,
      resolve(payload: CapsulePreviewChangedEvent) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsulePreviewEventName, CapsuleEventDefinition>
