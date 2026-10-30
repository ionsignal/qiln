import { z } from 'zod'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { isRecord } from '../../../guards'

/**
 * Bounded, authored context for discovery evidence that failed validation.
 * Paths and expectations come from Qiln's own schema. Provider values,
 * messages, and property names never enter it.
 */
const PATH = /^[A-Za-z][\w.[\]]{0,159}$/
const EXPECTED = /^[A-Za-z0-9 ]{1,64}$/

export const VALUE_KINDS = ['null', 'undefined', 'string', 'number', 'boolean', 'list', 'record', 'other'] as const

export type ValueKind = (typeof VALUE_KINDS)[number]
export type Issue = z.infer<typeof issueSchema>

export const issueSchema = z.strictObject({
  path: z.string().regex(PATH),
  expected: z.string().regex(EXPECTED),
  received: z.enum(VALUE_KINDS),
})

export function kindOf(value: unknown): ValueKind {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'list'
  }
  if (isRecord(value)) {
    return 'record'
  }
  switch (typeof value) {
    case 'undefined':
      return 'undefined'
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'other'
  }
}

/**
 * Renders a validated issue as diagnostic facts. Every value is authored by
 * Qiln, so nothing provider-supplied reaches the terminal through this path.
 */
export function issueFacts(issue: Issue): readonly DiagnosticFact[] {
  return [
    ['Stage', 'evidence validation'],
    ['Field', issue.path],
    ['Expected', issue.expected],
    ['Received', issue.received],
  ]
}

/**
 * The issue travels beside the existing discovery code, so classification
 * and certainty stay with the shared child classifier.
 */
export class DiscoveryError extends InstallerError {
  constructor(public readonly issue: Issue) {
    super({
      code: 'AWS_DEPLOYMENT_DISCOVERY_FAILED',
    })
  }
}
