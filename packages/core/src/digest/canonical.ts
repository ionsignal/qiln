import { createHash } from 'node:crypto'
import { GlobalError, GlobalErrorCode } from '../errors'

export type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson }
export type CanonicalSha256Digest = `sha256:${string}`

export interface CanonicalJsonDigestOptions {
  context?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Converts JSON-compatible data into a stable key-sorted representation.
 *
 * Qiln uses this for reviewed digests and idempotency hashes. It intentionally
 * rejects non-JSON values instead of trying to serialize runtime-specific data
 * such as functions, symbols, or class instances.
 */
export function toCanonicalJsonValue(value: unknown, context = 'value'): CanonicalJson {
  if (value === null) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new GlobalError(`Cannot create deterministic digest for non-finite number at '${context}'.`, GlobalErrorCode.INTERNAL_ERROR, {
        context,
        value,
      })
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toCanonicalJsonValue(item, `${context}[${index}]`))
  }
  if (isRecord(value)) {
    const canonical: Record<string, CanonicalJson> = {}
    const keys = Object.keys(value).sort((left, right) => left.localeCompare(right))
    for (const key of keys) {
      const child = value[key]
      if (child === undefined) {
        continue
      }
      canonical[key] = toCanonicalJsonValue(child, `${context}.${key}`)
    }
    return canonical
  }
  throw new GlobalError(`Cannot create deterministic digest for non-JSON value at '${context}'.`, GlobalErrorCode.INTERNAL_ERROR, {
    context,
    valueType: typeof value,
  })
}

/**
 * Creates a deterministic SHA-256 digest from canonical JSON-compatible data.
 *
 * This helper is server-only because it depends on Node crypto. Do not export it
 * from `@qiln/core/client`.
 */
export function digestCanonicalJsonValue(value: unknown, options: CanonicalJsonDigestOptions = {}): CanonicalSha256Digest {
  const context = options.context ?? 'value'
  const canonicalJson = JSON.stringify(toCanonicalJsonValue(value, context))
  if (canonicalJson === undefined) {
    throw new GlobalError(`Failed to serialize canonical JSON value for digest generation at '${context}'.`, GlobalErrorCode.INTERNAL_ERROR, {
      context,
    })
  }
  return `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`
}
