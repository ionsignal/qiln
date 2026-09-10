import { z } from 'zod'
import {
  CapsuleBlueprintCommandDefinitions,
  CapsuleBlueprintCommandName,
  CapsuleBlueprintCommandNameValues,
} from './blueprint'
import {
  CapsuleBranchCommandDefinitions,
  CapsuleBranchCommandName,
  CapsuleBranchCommandNameValues,
  CapsuleBranchEventDefinitions,
  CapsuleBranchEventName,
  CapsuleBranchEventNameValues,
  CapsuleBranchEventSchemas,
} from './branch'
import { CapsuleCreateCommandDefinitions, CapsuleCreateCommandName, CapsuleCreateCommandNameValues } from './create'
import { CapsuleForkCommandDefinitions, CapsuleForkCommandName, CapsuleForkCommandNameValues } from './fork'
import {
  CapsuleLifecycleCommandDefinitions,
  CapsuleLifecycleCommandName,
  CapsuleLifecycleCommandNameValues,
  CapsuleLifecycleEventDefinitions,
  CapsuleLifecycleEventName,
  CapsuleLifecycleEventNameValues,
  CapsuleLifecycleEventSchemas,
} from './lifecycle'
import {
  CapsuleOperationEventDefinitions,
  CapsuleOperationEventName,
  CapsuleOperationEventNameValues,
  CapsuleOperationEventSchemas,
} from './operation'
import {
  CapsulePreviewCommandDefinitions,
  CapsulePreviewCommandName,
  CapsulePreviewCommandNameValues,
  CapsulePreviewEventDefinitions,
  CapsulePreviewEventName,
  CapsulePreviewEventNameValues,
  CapsulePreviewEventSchemas,
} from './preview'
import {
  CapsuleRouteCommandDefinitions,
  CapsuleRouteCommandName,
  CapsuleRouteCommandNameValues,
  CapsuleRouteEventDefinitions,
  CapsuleRouteEventName,
  CapsuleRouteEventNameValues,
  CapsuleRouteEventSchemas,
} from './routing'
import {
  CapsuleSnapshotCommandDefinitions,
  CapsuleSnapshotCommandName,
  CapsuleSnapshotCommandNameValues,
} from './snapshot'
import {
  CapsuleSshAccessCommandDefinitions,
  CapsuleSshAccessCommandName,
  CapsuleSshAccessCommandNameValues,
  CapsuleSshControlCommandDefinitions,
  CapsuleSshControlCommandName,
  CapsuleSshControlCommandNameValues,
} from './ssh/index'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from '../definitions'

export * from '../definitions'
export * from './blueprint'
export * from './branch'
export * from './create'
export * from './fork'
export * from './lifecycle'
export * from './operation'
export * from './preview'
export * from './routing'
export * from './snapshot'
export * from './ssh/index'

export const CapsuleCommandName = {
  ...CapsuleCreateCommandName,
  ...CapsuleForkCommandName,
  ...CapsuleBranchCommandName,
  ...CapsuleLifecycleCommandName,
  ...CapsulePreviewCommandName,
  ...CapsuleRouteCommandName,
  ...CapsuleSnapshotCommandName,
  ...CapsuleSshAccessCommandName,
  ...CapsuleSshControlCommandName,
  ...CapsuleBlueprintCommandName,
} as const

export type CapsuleCommandName = (typeof CapsuleCommandName)[keyof typeof CapsuleCommandName]

export const CapsuleCommandNameValues = [
  ...CapsuleCreateCommandNameValues,
  ...CapsuleForkCommandNameValues,
  ...CapsuleBranchCommandNameValues,
  ...CapsuleLifecycleCommandNameValues,
  ...CapsulePreviewCommandNameValues,
  ...CapsuleRouteCommandNameValues,
  ...CapsuleSnapshotCommandNameValues,
  ...CapsuleSshAccessCommandNameValues,
  ...CapsuleSshControlCommandNameValues,
  ...CapsuleBlueprintCommandNameValues,
] as const

export const CapsuleCommandNameSchema = z.enum(CapsuleCommandNameValues)

export const CapsuleEventName = {
  ...CapsuleBranchEventName,
  ...CapsuleLifecycleEventName,
  ...CapsuleOperationEventName,
  ...CapsulePreviewEventName,
  ...CapsuleRouteEventName,
} as const

export type CapsuleEventName = (typeof CapsuleEventName)[keyof typeof CapsuleEventName]

export const CapsuleEventNameValues = [
  ...CapsuleBranchEventNameValues,
  ...CapsuleLifecycleEventNameValues,
  ...CapsuleOperationEventNameValues,
  ...CapsulePreviewEventNameValues,
  ...CapsuleRouteEventNameValues,
] as const

export const CapsuleEventNameSchema = z.enum(CapsuleEventNameValues)

export const CapsuleCommandDefinitions = {
  ...CapsuleCreateCommandDefinitions,
  ...CapsuleForkCommandDefinitions,
  ...CapsuleBranchCommandDefinitions,
  ...CapsuleLifecycleCommandDefinitions,
  ...CapsulePreviewCommandDefinitions,
  ...CapsuleRouteCommandDefinitions,
  ...CapsuleSnapshotCommandDefinitions,
  ...CapsuleSshAccessCommandDefinitions,
  ...CapsuleSshControlCommandDefinitions,
  ...CapsuleBlueprintCommandDefinitions,
} as const satisfies Record<CapsuleCommandName, CapsuleCommandDefinition>

export type CapsuleCommandRegistry = typeof CapsuleCommandDefinitions
export type CapsuleCommandDefinitionFor<TName extends CapsuleCommandName> = CapsuleCommandRegistry[TName]
export type AnyCapsuleCommandDefinition = CapsuleCommandRegistry[keyof CapsuleCommandRegistry]

export const CapsuleEventDefinitions = {
  ...CapsuleBranchEventDefinitions,
  ...CapsuleLifecycleEventDefinitions,
  ...CapsuleOperationEventDefinitions,
  ...CapsulePreviewEventDefinitions,
  ...CapsuleRouteEventDefinitions,
} as const satisfies Record<CapsuleEventName, CapsuleEventDefinition>

export type CapsuleEventRegistry = typeof CapsuleEventDefinitions
export type CapsuleEventDefinitionFor<TName extends CapsuleEventName> = CapsuleEventRegistry[TName]
export type AnyCapsuleEventDefinition = CapsuleEventRegistry[keyof CapsuleEventRegistry]

const CapsuleEventSchemas = [
  ...CapsuleBranchEventSchemas,
  ...CapsuleLifecycleEventSchemas,
  ...CapsuleOperationEventSchemas,
  ...CapsulePreviewEventSchemas,
  ...CapsuleRouteEventSchemas,
] as const

export const CapsuleEventSchema = z.discriminatedUnion('type', CapsuleEventSchemas)
export type CapsuleEvent = z.infer<typeof CapsuleEventSchema>

interface CapsuleNamedDefinition {
  name: string
  kind: string
}

function assertUniqueCapsuleNames(names: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`[CapsuleProtocol] Duplicate ${label} name '${name}'.`)
    }
    seen.add(name)
  }
}

function assertCapsuleDefinitionRegistry(
  names: readonly string[],
  definitions: Readonly<Record<string, CapsuleNamedDefinition>>,
  label: string,
): void {
  assertUniqueCapsuleNames(names, label)
  const expectedNames = new Set(names)
  const definitionNames = new Set<string>()
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(definitions, name)) {
      throw new Error(`[CapsuleProtocol] Missing ${label} definition for '${name}'.`)
    }
  }
  for (const [key, definition] of Object.entries(definitions)) {
    if (key !== definition.name) {
      throw new Error(
        `[CapsuleProtocol] ${label} definition registry key '${key}' does not match definition name '${definition.name}'.`,
      )
    }
    if (!expectedNames.has(definition.name)) {
      throw new Error(`[CapsuleProtocol] ${label} definition '${definition.name}' is not listed in ${label} names.`)
    }
    if (definitionNames.has(definition.name)) {
      throw new Error(`[CapsuleProtocol] Duplicate ${label} definition '${definition.name}'.`)
    }
    definitionNames.add(definition.name)
  }
}

assertCapsuleDefinitionRegistry(CapsuleCommandNameValues, CapsuleCommandDefinitions, 'command')
assertCapsuleDefinitionRegistry(CapsuleEventNameValues, CapsuleEventDefinitions, 'event')

export function isCapsuleCommandName(name: string): name is CapsuleCommandName {
  return Object.prototype.hasOwnProperty.call(CapsuleCommandDefinitions, name)
}

export function isCapsuleEventName(name: string): name is CapsuleEventName {
  return Object.prototype.hasOwnProperty.call(CapsuleEventDefinitions, name)
}

export function getCapsuleCommandDefinition<TName extends CapsuleCommandName>(
  name: TName,
): CapsuleCommandDefinitionFor<TName>
export function getCapsuleCommandDefinition(name: string): AnyCapsuleCommandDefinition | undefined
export function getCapsuleCommandDefinition(name: string): AnyCapsuleCommandDefinition | undefined {
  if (!isCapsuleCommandName(name)) {
    return undefined
  }
  return CapsuleCommandDefinitions[name]
}

export function getCapsuleEventDefinition<TName extends CapsuleEventName>(name: TName): CapsuleEventDefinitionFor<TName>
export function getCapsuleEventDefinition(name: string): AnyCapsuleEventDefinition | undefined
export function getCapsuleEventDefinition(name: string): AnyCapsuleEventDefinition | undefined {
  if (!isCapsuleEventName(name)) {
    return undefined
  }
  return CapsuleEventDefinitions[name]
}
