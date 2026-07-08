import { IncusError } from '../../../../errors'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export function toJsonObject(value: Record<string, unknown>, context: string): Record<string, unknown> {
  const normalized = toJsonValue(value, context)
  if (!isJsonObject(normalized)) {
    throw new IncusError(`${context} must normalize to a JSON object.`, 'VALIDATION_ERROR', {
      context,
    })
  }
  return normalized
}

function toJsonValue(value: unknown, context: string, seen: WeakSet<object> = new WeakSet()): JsonValue {
  if (value === null) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IncusError(`Cannot persist non-finite number in ${context}.`, 'VALIDATION_ERROR', {
        context,
        value,
      })
    }
    return value
  }

  if (value instanceof Date) {
    const timestamp = value.getTime()
    if (!Number.isFinite(timestamp)) {
      throw new IncusError(`Cannot persist invalid Date in ${context}.`, 'VALIDATION_ERROR', {
        context,
      })
    }
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new IncusError(`Cannot persist cyclic array in ${context}.`, 'VALIDATION_ERROR', {
        context,
      })
    }
    seen.add(value)
    try {
      return value.map((item, index) => (item === undefined ? null : toJsonValue(item, `${context}[${index}]`, seen)))
    } finally {
      seen.delete(value)
    }
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new IncusError(`Cannot persist cyclic object in ${context}.`, 'VALIDATION_ERROR', {
        context,
      })
    }
    if (!isPlainObject(value)) {
      throw new IncusError(`Cannot persist non-plain object in ${context}.`, 'VALIDATION_ERROR', {
        context,
        valueType: value.constructor?.name ?? 'Object',
      })
    }
    seen.add(value)
    try {
      const record = value as Record<string, unknown>
      const jsonObject: JsonObject = {}
      for (const [key, child] of Object.entries(record)) {
        if (child === undefined) {
          continue
        }

        jsonObject[key] = toJsonValue(child, `${context}.${key}`, seen)
      }
      return jsonObject
    } finally {
      seen.delete(value)
    }
  }

  throw new IncusError(`Cannot persist non-JSON value in ${context}.`, 'VALIDATION_ERROR', {
    context,
    valueType: typeof value,
  })
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
