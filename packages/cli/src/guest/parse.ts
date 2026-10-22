import { z } from 'zod'

export interface CloudInitStatus {
  status: string
  extendedStatus: string
  errors: number
  recoverableErrors: number
}

export interface OsRelease {
  id: string
  versionId: string
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const ARCHITECTURE = /^[A-Za-z0-9_]{1,32}$/
const SHORT_TEXT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,39}$/

/**
 * Required fields only, never optional or defaulted. `recoverable_errors` is
 * documented as an object, but an empty list is the approved compatibility
 * shape. The preserving record keeps populated groups, so emptiness is judged
 * by key count rather than by a schema that would strip them.
 */
const cloudInitSchema = z.object({
  status: z.string(),
  extended_status: z.string(),
  errors: z.array(z.unknown()),
  recoverable_errors: z.union([z.array(z.unknown()), z.record(z.string(), z.array(z.unknown()))]),
})

/**
 * Guest-supplied text is echoed only when it matches a short authored pattern.
 */
export function shortText(value: string): string {
  return SHORT_TEXT.test(value) ? value : 'unrecognized'
}

export function parseCloudInit(output: string): CloudInitStatus | null {
  let json: unknown
  try {
    json = JSON.parse(output) as unknown
  } catch {
    return null
  }
  const parsed = cloudInitSchema.safeParse(json)
  if (!parsed.success) {
    return null
  }
  const { status, extended_status, errors, recoverable_errors } = parsed.data
  return {
    status,
    extendedStatus: extended_status,
    errors: errors.length,
    recoverableErrors: Array.isArray(recoverable_errors)
      ? recoverable_errors.length
      : Object.keys(recoverable_errors).length,
  }
}

export function cloudInitClean(report: CloudInitStatus): boolean {
  return (
    report.status === 'done' &&
    report.extendedStatus === 'done' &&
    report.errors === 0 &&
    report.recoverableErrors === 0
  )
}

/**
 * Decodes one os-release value as data: unquoted, single-quoted, or
 * double-quoted. Expansion and concatenated fragments are unsupported.
 */
function decodeValue(raw: string): string | null {
  const quote = raw.charAt(0)
  if (quote !== '"' && quote !== "'") {
    return /^[^\s"'\\$`]*$/.test(raw) ? raw : null
  }
  if (raw.length < 2 || raw.charAt(raw.length - 1) !== quote) {
    return null
  }
  const body = raw.slice(1, -1)
  if (quote === "'") {
    return body.includes("'") ? null : body
  }
  let value = ''
  for (let index = 0; index < body.length; index++) {
    const char = body.charAt(index)
    if (char === '"') {
      return null
    }
    if (char === '\\') {
      index += 1
      const escaped = body.charAt(index)
      if (escaped === '' || !'"\\$`'.includes(escaped)) {
        return null
      }
      value += escaped
    } else {
      value += char
    }
  }
  return value
}

/**
 * Parses the file as data and never evaluates it. A duplicate required key is
 * rejected, which is stricter than the last-value reader guidance.
 */
export function parseOsRelease(text: string): OsRelease | null {
  const required = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const match = ASSIGNMENT.exec(trimmed)
    const key = match?.[1]
    const value = match?.[2]
    if (key === undefined || value === undefined) {
      return null
    }
    if (key === 'ID' || key === 'VERSION_ID') {
      if (required.has(key)) {
        return null
      }
      required.set(key, value)
    }
  }
  const rawId = required.get('ID')
  const rawVersionId = required.get('VERSION_ID')
  if (rawId === undefined || rawVersionId === undefined) {
    return null
  }
  const id = decodeValue(rawId)
  const versionId = decodeValue(rawVersionId)
  return id === null || versionId === null ? null : { id, versionId }
}

export function parseArchitecture(output: string): string | null {
  const token = output.trim()
  return ARCHITECTURE.test(token) ? token : null
}
