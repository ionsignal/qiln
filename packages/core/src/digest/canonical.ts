import { createHash } from 'node:crypto'
import { GlobalError, GlobalErrorCode } from '../errors'

export type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson }
export type CanonicalSha256Digest = `sha256:${string}`

export interface CanonicalJsonDigestOptions {
  context?: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareCanonicalString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function runtimeObjectType(value: object): string {
  const constructorValue = (value as { constructor?: unknown }).constructor
  if (typeof constructorValue === 'function' && constructorValue.name) {
    return constructorValue.name
  }
  return Object.prototype.toString.call(value)
}

function throwUnsupportedCanonicalValue(context: string, value: unknown, reason?: string): never {
  const details: Record<string, unknown> = {
    context,
    valueType: typeof value,
  }
  if (typeof value === 'object' && value !== null) {
    details.objectType = runtimeObjectType(value)
  }
  if (reason !== undefined) {
    details.reason = reason
  }
  throw new GlobalError(`Cannot create deterministic digest for non-JSON value at '${context}'.`, GlobalErrorCode.INTERNAL_ERROR, details)
}

function assertNoSymbolProperties(value: object, context: string): void {
  const symbols = Object.getOwnPropertySymbols(value)
  if (symbols.length === 0) {
    return
  }
  throwUnsupportedCanonicalValue(context, value, 'Canonical JSON values cannot contain symbol-keyed properties.')
}

function toCanonicalArray(value: unknown[], context: string, ancestors: WeakSet<object>): CanonicalJson[] {
  if (ancestors.has(value)) {
    throwUnsupportedCanonicalValue(context, value, 'Canonical JSON values cannot contain cycles.')
  }

  assertNoSymbolProperties(value, context)

  const enumerableKeys = Object.keys(value)
  if (enumerableKeys.length !== value.length || enumerableKeys.some((key, index) => key !== String(index))) {
    throwUnsupportedCanonicalValue(context, value, 'Canonical JSON arrays must be dense and cannot contain custom enumerable properties.')
  }
  const ownPropertyNames = Object.getOwnPropertyNames(value)
  if (ownPropertyNames.length !== value.length + 1 || ownPropertyNames.some(name => name !== 'length' && !enumerableKeys.includes(name))) {
    throwUnsupportedCanonicalValue(context, value, 'Canonical JSON arrays cannot contain custom non-enumerable properties.')
  }
  ancestors.add(value)
  try {
    const canonical: CanonicalJson[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor)) {
        throwUnsupportedCanonicalValue(`${context}[${index}]`, value, 'Canonical JSON array entries must be ordinary data properties.')
      }
      canonical.push(toCanonicalJsonValueInternal(descriptor.value, `${context}[${index}]`, ancestors))
    }
    return canonical
  } finally {
    ancestors.delete(value)
  }
}

function toCanonicalRecord(
  value: Record<string, unknown>,
  context: string,
  ancestors: WeakSet<object>,
): {
  [key: string]: CanonicalJson
} {
  if (ancestors.has(value)) {
    throwUnsupportedCanonicalValue(context, value, 'Canonical JSON values cannot contain cycles.')
  }

  assertNoSymbolProperties(value, context)

  const enumerableKeys = Object.keys(value)
  const ownPropertyNames = Object.getOwnPropertyNames(value)
  if (
    enumerableKeys.length !== ownPropertyNames.length ||
    ownPropertyNames.some(name => !Object.prototype.propertyIsEnumerable.call(value, name))
  ) {
    throwUnsupportedCanonicalValue(context, value, 'Canonical JSON objects cannot contain non-enumerable properties.')
  }
  ancestors.add(value)
  try {
    const canonical = Object.create(null) as { [key: string]: CanonicalJson }
    const keys = [...enumerableKeys].sort(compareCanonicalString)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        throwUnsupportedCanonicalValue(`${context}.${key}`, value, 'Canonical JSON properties must be ordinary data properties.')
      }
      Object.defineProperty(canonical, key, {
        value: toCanonicalJsonValueInternal(descriptor.value, `${context}.${key}`, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return canonical
  } finally {
    ancestors.delete(value)
  }
}

function toCanonicalJsonValueInternal(value: unknown, context: string, ancestors: WeakSet<object>): CanonicalJson {
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
    return toCanonicalArray(value, context, ancestors)
  }
  if (isPlainRecord(value)) {
    return toCanonicalRecord(value, context, ancestors)
  }
  return throwUnsupportedCanonicalValue(context, value)
}

/**
 * Converts strict JSON-compatible data into a stable key-sorted
 * representation.
 *
 * Qiln uses this for reviewed digests and idempotency hashes. It rejects
 * undefined values, sparse arrays, accessors, symbol properties, cycles,
 * non-plain objects, and other runtime-specific values rather than silently
 * coercing or omitting them. JSON property names, including `__proto__`,
 * remain ordinary data keys.
 */
export function toCanonicalJsonValue(value: unknown, context = 'value'): CanonicalJson {
  return toCanonicalJsonValueInternal(value, context, new WeakSet<object>())
}

/**
 * Creates a deterministic SHA-256 digest from strict JSON-compatible data.
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
