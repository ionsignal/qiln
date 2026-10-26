import { isRecord } from '../../guards'

export interface PolicySummary {
  changes: string[]
  reads: number
  launchTypes: string[]
}

function actionsOf(statement: unknown): string[] {
  if (!isRecord(statement)) {
    return []
  }
  const raw: unknown = statement.Action
  const values: unknown[] = Array.isArray(raw) ? raw : [raw]
  return values.filter((value): value is string => typeof value === 'string').map(value => value.replace(/^ec2:/, ''))
}

function isRead(action: string): boolean {
  return action.startsWith('Describe') || action.startsWith('Get')
}

/**
 * Instance types that a launch statement permits. This is the one condition
 * the summary reads, because it defines launch scope rather than narrowing it.
 */
function launchTypesOf(statement: unknown): string[] {
  if (!isRecord(statement) || !actionsOf(statement).includes('RunInstances') || !isRecord(statement.Condition)) {
    return []
  }
  const equals = statement.Condition.StringEquals
  const raw: unknown = isRecord(equals) ? equals['ec2:InstanceType'] : undefined
  const values: unknown[] = Array.isArray(raw) ? raw : [raw]
  return values.filter((value): value is string => typeof value === 'string')
}

/**
 * Derived from the exact document that is hashed and persisted with the
 * approval, so the disclosure cannot drift from what is approved. Other
 * conditions are not interpreted: they only narrow the listed actions. Launch
 * types keep document order.
 */
export function summarize(document: string): PolicySummary {
  const parsed: unknown = JSON.parse(document)
  const raw: unknown = isRecord(parsed) ? parsed.Statement : undefined
  const statements: unknown[] = Array.isArray(raw) ? raw : []
  const actions = [...new Set(statements.flatMap(actionsOf))].sort()
  return {
    changes: actions.filter(action => !isRead(action)),
    reads: actions.filter(isRead).length,
    launchTypes: [...new Set(statements.flatMap(launchTypesOf))],
  }
}
