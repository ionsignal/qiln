import { InstallerError, type InstallerErrorCode } from '../diagnostic/error'
import { isRecord } from './guards'
import { AWS_SPEC } from './spec'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
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
 * refused before writing rather than persisted unreadable. The bound defaults
 * to the deployment record's and is passed explicitly by other record kinds.
 */
export function encodeRecord(value: unknown, code: InstallerErrorCode, limit: number = AWS_SPEC.limits.record): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (bytes.byteLength > limit) {
    throw new InstallerError({
      code,
    })
  }
  return bytes
}

/**
 * Some SDK responses already contain plain JSON. Decode only when direct
 * parsing fails, so literal percent characters are not decoded twice.
 */
export function document(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 65_536) {
    return invalid()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    try {
      parsed = JSON.parse(decodeURIComponent(value)) as unknown
    } catch {
      return invalid()
    }
  }
  return canonical(parsed)
}
