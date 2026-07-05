import { z } from 'zod'
import { CapsuleBlueprintManifestSchema } from '../../../schemas'
import { TargetSystemSchema, TargetType } from '../targets'
import { defineCapsuleCommand } from './definitions'
import type { input, output } from 'zod'
import type { CapsuleCommandDefinition } from './definitions'

const CAPSULE_BLUEPRINTS_LIST_TIMEOUT_MS = 15_000

/**
 * Blueprint command names are scoped to worker-authoritative capsule blueprint
 * discovery. Full blueprint provisioning details remain worker-side.
 */
export const CapsuleBlueprintCommandName = {
  BLUEPRINTS_LIST: 'capsule.blueprints.list',
} as const

export type CapsuleBlueprintCommandName = (typeof CapsuleBlueprintCommandName)[keyof typeof CapsuleBlueprintCommandName]

export const CapsuleBlueprintCommandNameValues = [CapsuleBlueprintCommandName.BLUEPRINTS_LIST] as const

/**
 * Lists the worker-authoritative capsule blueprint manifest.
 *
 * This is system-targeted because blueprint catalog availability is a global
 * worker capability, not an owner-scoped or capsule-scoped resource.
 */
export const CapsuleBlueprintsListInputSchema = z
  .object({
    target: TargetSystemSchema,
  })
  .strict()

export const CapsuleBlueprintsListOutputSchema = CapsuleBlueprintManifestSchema

export type CapsuleBlueprintsListInput = input<typeof CapsuleBlueprintsListInputSchema>
export type CapsuleBlueprintsList = output<typeof CapsuleBlueprintsListInputSchema>
export type CapsuleBlueprintsListOutput = output<typeof CapsuleBlueprintsListOutputSchema>

export const CapsuleBlueprintCommandDefinitions = {
  [CapsuleBlueprintCommandName.BLUEPRINTS_LIST]: defineCapsuleCommand({
    kind: 'capsule.command',
    name: CapsuleBlueprintCommandName.BLUEPRINTS_LIST,
    inputSchema: CapsuleBlueprintsListInputSchema,
    outputSchema: CapsuleBlueprintsListOutputSchema,
    timeoutMs: CAPSULE_BLUEPRINTS_LIST_TIMEOUT_MS,
    target: {
      type: TargetType.SYSTEM,
      resolve(payload: CapsuleBlueprintsList) {
        return payload.target
      },
    },
  }),
} as const satisfies Record<CapsuleBlueprintCommandName, CapsuleCommandDefinition>
