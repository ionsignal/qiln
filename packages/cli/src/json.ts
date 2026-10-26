import { InstallerError, type InstallerErrorCode } from './diagnostic/error'
import { isRecord } from './guards'

function invalid(): never {
  throw new InstallerError({
    code: 'INTERNAL_ERROR',
  })
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown) => canonical(entry)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return invalid()
}

/**
 * Compares by canonical form, so a non-JSON value (such as `undefined`) fails
 * loudly instead of comparing equal to another missing value.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

/**
 * Evidence is never pruned, so a record that would outgrow its read bound is
 * refused before writing rather than persisted unreadable. Each record kind
 * supplies its own bound.
 */
export function encodeRecord(value: unknown, code: InstallerErrorCode, limit: number): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.byteLength > limit) {
    throw new InstallerError({
      code,
    })
  }
  return bytes
}
