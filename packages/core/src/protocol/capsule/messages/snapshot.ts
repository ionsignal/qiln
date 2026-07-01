import type { ZodType } from 'zod'
import type { CapsuleCommandDefinition, CapsuleEventDefinition } from './definitions'

/**
 * Snapshot protocol namespace scaffold.
 *
 * This file intentionally defines no public snapshot commands/events yet. It
 * exists so the aggregate registry shape in `messages/index.ts` is already ready
 * for namespace expansion without making unfinished snapshot semantics visible
 * through the public protocol surface.
 */
export const CapsuleSnapshotCommandName = {} as const

export type CapsuleSnapshotCommandName = (typeof CapsuleSnapshotCommandName)[keyof typeof CapsuleSnapshotCommandName]

export const CapsuleSnapshotCommandNameValues = [] as const

export const CapsuleSnapshotEventName = {} as const

export type CapsuleSnapshotEventName = (typeof CapsuleSnapshotEventName)[keyof typeof CapsuleSnapshotEventName]

export const CapsuleSnapshotEventNameValues = [] as const

export const CapsuleSnapshotCommandDefinitions = {} as const satisfies Record<CapsuleSnapshotCommandName, CapsuleCommandDefinition>

export const CapsuleSnapshotEventDefinitions = {} as const satisfies Record<CapsuleSnapshotEventName, CapsuleEventDefinition>

export const CapsuleSnapshotEventSchemas = [] as const satisfies readonly ZodType[]
