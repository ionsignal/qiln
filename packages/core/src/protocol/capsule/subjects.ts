import { TargetSchema, TargetTypeSchema, assertTarget, type Target, type TargetTypeValue } from './targets'
import type { CapsuleCommandName, CapsuleEventName } from './messages'

const CAPSULE_WILDCARD_TARGET = '*'
const CAPSULE_DEEP_WILDCARD = '>'

export const CAPSULE_COMMAND_SUBJECT_PREFIX = 'qiln.cmd'
export const CAPSULE_EVENT_SUBJECT_PREFIX = 'qiln.evt'

export const CapsuleSubjectKind = {
  COMMAND: 'command',
  EVENT: 'event',
} as const

export type CapsuleSubjectKind = (typeof CapsuleSubjectKind)[keyof typeof CapsuleSubjectKind]

export interface ParsedCapsuleSubject {
  kind: CapsuleSubjectKind
  target: Target
  operation: string
}

/**
 * NATS subjects are dot-tokenized. Capsule targets must remain concrete tokens so
 * ownership/capsule/system checks cannot be bypassed by ambiguous subject parsing.
 */
export function assertCapsuleSubjectTarget(target: unknown, context: string): asserts target is Target {
  assertTarget(target, context)
}

export function buildCapsuleCommandSubject(target: Target, commandName: CapsuleCommandName): string {
  assertCapsuleSubjectTarget(target, commandName)
  return `${CAPSULE_COMMAND_SUBJECT_PREFIX}.${target.type}.${target.id}.${commandName}`
}

export function buildCapsuleCommandHandlerSubject(targetType: TargetTypeValue, commandName: CapsuleCommandName): string {
  return `${CAPSULE_COMMAND_SUBJECT_PREFIX}.${targetType}.${CAPSULE_WILDCARD_TARGET}.${commandName}`
}

export function buildCapsuleEventSubject(target: Target, eventName: CapsuleEventName): string {
  assertCapsuleSubjectTarget(target, eventName)
  return `${CAPSULE_EVENT_SUBJECT_PREFIX}.${target.type}.${target.id}.${eventName}`
}

export function buildCapsuleEventSubscriptionSubject(target?: Target): string {
  if (!target) {
    return `${CAPSULE_EVENT_SUBJECT_PREFIX}.${CAPSULE_DEEP_WILDCARD}`
  }
  assertCapsuleSubjectTarget(target, 'capsule event subscription')
  return `${CAPSULE_EVENT_SUBJECT_PREFIX}.${target.type}.${target.id}.${CAPSULE_DEEP_WILDCARD}`
}

export function parseCapsuleSubject(subject: string): ParsedCapsuleSubject | null {
  const parts = subject.split('.')
  if (parts.length < 5) {
    return null
  }
  const prefix = `${parts[0]}.${parts[1]}`
  const targetType = TargetTypeSchema.safeParse(parts[2])
  if (!targetType.success) {
    return null
  }
  const target = TargetSchema.safeParse({
    type: targetType.data,
    id: parts[3],
  })
  if (!target.success) {
    return null
  }
  const operation = parts.slice(4).join('.')
  if (operation.trim() === '') {
    return null
  }
  if (prefix === CAPSULE_COMMAND_SUBJECT_PREFIX) {
    return {
      kind: CapsuleSubjectKind.COMMAND,
      target: target.data,
      operation,
    }
  }
  if (prefix === CAPSULE_EVENT_SUBJECT_PREFIX) {
    return {
      kind: CapsuleSubjectKind.EVENT,
      target: target.data,
      operation,
    }
  }
  return null
}
