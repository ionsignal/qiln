import { createHash } from 'node:crypto'
import { IncusError } from '../../../../../errors'
import type { CapsuleBlueprintDigest } from '@qiln/core/server'

type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson }

export interface BranchCreateRequestHashInput {
  name: string
  blueprintName: string
  blueprintDigest: CapsuleBlueprintDigest
  cpu: string
  memory: string
}

export function createBranchCreateRequestHash(input: BranchCreateRequestHashInput): string {
  const canonicalJson = JSON.stringify(toCanonicalJson(input))
  if (canonicalJson === undefined) {
    throw new IncusError('Failed to serialize capsule branch create input for idempotency hashing.', 'VALIDATION_ERROR')
  }
  return `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`
}

/**
 * Recovery needs to recompute the same hashes across process restarts, so this
 * deliberately canonicalizes plain JSON-compatible values instead of relying on
 * insertion order from caller objects.
 */
function toCanonicalJson(value: unknown, context = 'value'): CanonicalJson {
  if (value === null) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IncusError(`Cannot hash non-finite number at '${context}'.`, 'VALIDATION_ERROR', {
        context,
        value,
      })
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toCanonicalJson(item, `${context}[${index}]`))
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const canonical: Record<string, CanonicalJson> = {}
    const keys = Object.keys(record).sort((left, right) => left.localeCompare(right))
    for (const key of keys) {
      const child = record[key]
      if (child === undefined) {
        continue
      }
      canonical[key] = toCanonicalJson(child, `${context}.${key}`)
    }
    return canonical
  }
  throw new IncusError(`Cannot hash non-JSON value at '${context}'.`, 'VALIDATION_ERROR', {
    context,
    valueType: typeof value,
  })
}
