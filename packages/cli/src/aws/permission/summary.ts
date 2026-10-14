import { isRecord } from '../guards'

export interface PolicySummary {
  changes: string[]
  reads: number
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
 * Derived from the exact document that is hashed and persisted with the
 * approval, so the disclosure cannot drift from what is approved. Conditions
 * are not interpreted: they only narrow the listed actions.
 */
export function summarize(document: string): PolicySummary {
  const parsed: unknown = JSON.parse(document)
  const raw: unknown = isRecord(parsed) ? parsed.Statement : undefined
  const statements: unknown[] = Array.isArray(raw) ? raw : []
  const actions = [...new Set(statements.flatMap(actionsOf))].sort()
  return {
    changes: actions.filter(action => !isRead(action)),
    reads: actions.filter(isRead).length,
  }
}
