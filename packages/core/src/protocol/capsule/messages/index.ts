import { z } from 'zod'
import {
  CapsuleBranchCommandDefinitions,
  CapsuleBranchCommandName,
  CapsuleBranchCommandNameValues,
  CapsuleBranchEventDefinitions,
  CapsuleBranchEventName,
  CapsuleBranchEventNameValues,
  CapsuleBranchEventSchemas,
} from './branch'
import {
  CapsuleSnapshotCommandDefinitions,
  CapsuleSnapshotCommandName,
  CapsuleSnapshotCommandNameValues,
  CapsuleSnapshotEventDefinitions,
  CapsuleSnapshotEventName,
  CapsuleSnapshotEventNameValues,
  CapsuleSnapshotEventSchemas,
} from './snapshot'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

export * from './definitions'
export * from './branch'

export const CapsuleCommandName = {
  ...CapsuleBranchCommandName,
  ...CapsuleSnapshotCommandName,
} as const

export type CapsuleCommandName = (typeof CapsuleCommandName)[keyof typeof CapsuleCommandName]

export const CapsuleCommandNameValues = [...CapsuleBranchCommandNameValues, ...CapsuleSnapshotCommandNameValues] as const
export const CapsuleCommandNameSchema = z.enum(CapsuleCommandNameValues)

export const CapsuleEventName = {
  ...CapsuleBranchEventName,
  ...CapsuleSnapshotEventName,
} as const

export type CapsuleEventName = (typeof CapsuleEventName)[keyof typeof CapsuleEventName]

export const CapsuleEventNameValues = [...CapsuleBranchEventNameValues, ...CapsuleSnapshotEventNameValues] as const
export const CapsuleEventNameSchema = z.enum(CapsuleEventNameValues)

export const CapsuleCommandDefinitions = {
  ...CapsuleBranchCommandDefinitions,
  ...CapsuleSnapshotCommandDefinitions,
} as const satisfies Record<CapsuleCommandName, CapsuleCommandDefinition>

export type CapsuleCommandRegistry = typeof CapsuleCommandDefinitions
export type CapsuleCommandDefinitionFor<TName extends CapsuleCommandName> = CapsuleCommandRegistry[TName]
export type AnyCapsuleCommandDefinition = CapsuleCommandRegistry[keyof CapsuleCommandRegistry]

export const CapsuleCommandDefinitionList = Object.values(CapsuleCommandDefinitions) as readonly AnyCapsuleCommandDefinition[]

export const CapsuleEventDefinitions = {
  ...CapsuleBranchEventDefinitions,
  ...CapsuleSnapshotEventDefinitions,
} as const satisfies Record<CapsuleEventName, CapsuleEventDefinition>

export type CapsuleEventRegistry = typeof CapsuleEventDefinitions
export type CapsuleEventDefinitionFor<TName extends CapsuleEventName> = CapsuleEventRegistry[TName]
export type AnyCapsuleEventDefinition = CapsuleEventRegistry[keyof CapsuleEventRegistry]

export const CapsuleEventDefinitionList = Object.values(CapsuleEventDefinitions) as readonly AnyCapsuleEventDefinition[]

const CapsuleEventSchemas = [...CapsuleBranchEventSchemas, ...CapsuleSnapshotEventSchemas] as const

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
      throw new Error(`[CapsuleProtocol] ${label} definition registry key '${key}' does not match definition name '${definition.name}'.`)
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

export function getCapsuleCommandDefinition<TName extends CapsuleCommandName>(name: TName): CapsuleCommandDefinitionFor<TName>
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
