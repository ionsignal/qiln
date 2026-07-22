import { CapsuleChannelError, GlobalError } from '@qiln/core/server'
import { IncusError } from '../../../errors'

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

export interface FailureNormalizationOptions {
  maxDepth?: number
  includeStack?: boolean
}

const DEFAULT_MAX_FAILURE_DETAIL_DEPTH = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function objectTypeName(value: object): string {
  const constructorValue = (value as { constructor?: unknown }).constructor
  if (typeof constructorValue === 'function' && constructorValue.name) {
    return constructorValue.name
  }
  return 'Object'
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const property = value[key]
  return typeof property === 'string' ? property : undefined
}

function readCodeProperty(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const code = value.code
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code)
  }
  return undefined
}

function readCause(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined
  }
  return value.cause
}

function readKnownFailureCode(value: unknown): string | undefined {
  if (value instanceof IncusError) {
    return value.code
  }
  if (value instanceof GlobalError) {
    return value.code
  }
  if (value instanceof CapsuleChannelError) {
    return value.code
  }
  return readCodeProperty(value)
}

function readKnownFailureDetails(value: unknown): unknown {
  if (value instanceof IncusError) {
    return value.details
  }
  if (value instanceof GlobalError) {
    return value.details
  }
  if (value instanceof CapsuleChannelError) {
    return value.details
  }
  if (!isRecord(value)) {
    return undefined
  }
  return value.details
}

function resolveNormalizationOptions(options: FailureNormalizationOptions): Required<FailureNormalizationOptions> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_FAILURE_DETAIL_DEPTH
  if (!Number.isFinite(maxDepth) || !Number.isInteger(maxDepth) || maxDepth <= 0) {
    throw new RangeError('Failure normalization maxDepth must be a positive finite integer.')
  }
  return {
    maxDepth,
    includeStack: options.includeStack ?? false,
  }
}

function normalizeUnknown(
  value: unknown,
  options: Required<FailureNormalizationOptions>,
  depth: number,
  seen: WeakSet<object>,
): JsonValue {
  if (depth >= options.maxDepth) {
    return '[MaxDepth]'
  }
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (typeof value === 'symbol') {
    return value.toString()
  }
  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`
  }
  const objectValue = value as object
  if (seen.has(objectValue)) {
    return '[Circular]'
  }
  seen.add(objectValue)
  try {
    if (value instanceof Date) {
      const timestamp = value.getTime()
      return Number.isFinite(timestamp) ? value.toISOString() : 'Invalid Date'
    }
    if (value instanceof Error) {
      return normalizeError(value, options, depth, seen)
    }
    if (Array.isArray(value)) {
      return value.map(item => normalizeUnknown(item, options, depth + 1, seen))
    }

    const normalized: JsonObject = {}
    if (!isPlainObject(objectValue)) {
      normalized.objectType = objectTypeName(objectValue)
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) {
        continue
      }
      normalized[key] = normalizeUnknown(child, options, depth + 1, seen)
    }
    return normalized
  } finally {
    seen.delete(objectValue)
  }
}

function normalizeError(
  error: Error,
  options: Required<FailureNormalizationOptions>,
  depth: number,
  seen: WeakSet<object>,
): JsonObject {
  const normalized: JsonObject = {
    name: error.name || 'Error',
    message: error.message,
  }
  const code = readKnownFailureCode(error)
  if (code !== undefined) {
    normalized.code = code
  }
  const details = readKnownFailureDetails(error)
  if (details !== undefined) {
    normalized.details = normalizeUnknown(details, options, depth + 1, seen)
  }
  const cause = readCause(error)
  if (cause !== undefined) {
    normalized.cause = normalizeUnknown(cause, options, depth + 1, seen)
  }
  if (options.includeStack && error.stack) {
    normalized.stack = error.stack
  }
  for (const [key, child] of Object.entries(error as unknown as Record<string, unknown>)) {
    if (
      child === undefined ||
      key === 'name' ||
      key === 'message' ||
      key === 'code' ||
      key === 'details' ||
      key === 'cause' ||
      key === 'stack'
    ) {
      continue
    }
    normalized[key] = normalizeUnknown(child, options, depth + 1, seen)
  }
  return normalized
}

/**
 * Converts unknown failure data into a bounded, circular-safe JSON object.
 *
 * This normalization is deliberately defensive and lossy. It is suitable for
 * durable Worker diagnostics but does not replace strict domain persistence
 * validation or client-facing sanitization.
 */
export function normalizeFailureDetails(
  value: unknown,
  options: FailureNormalizationOptions = {},
): Record<string, unknown> | undefined {
  const normalizedOptions = resolveNormalizationOptions(options)
  if (value === undefined || value === null) {
    return undefined
  }
  const normalized = normalizeUnknown(value, normalizedOptions, 0, new WeakSet<object>())
  if (isJsonObject(normalized)) {
    return normalized
  }
  return {
    value: normalized,
  }
}

export function failureCodeFromUnknown(value: unknown): string {
  const knownCode = readKnownFailureCode(value)
  if (knownCode !== undefined) {
    return knownCode
  }
  if (value instanceof Error && value.name) {
    return value.name
  }
  return 'UNKNOWN'
}

export function failureMessageFromUnknown(value: unknown, fallback = 'Unknown capsule operation failure.'): string {
  if (value instanceof Error && value.message) {
    return value.message
  }
  const message = readStringProperty(value, 'message')
  if (message) {
    return message
  }
  return fallback
}

/**
 * Builds the persisted Worker diagnostic envelope shared by capsule stores and
 * operation accounting.
 *
 * Raw diagnostics remain server-side and must pass through operation-specific
 * sanitization before being exposed to clients.
 */
export function createFailureDetails(
  error: unknown,
  context?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const errorDetails = normalizeFailureDetails(error)
  const contextDetails = context === undefined ? undefined : normalizeFailureDetails(context)
  if (errorDetails === undefined && contextDetails === undefined) {
    return undefined
  }
  const details: Record<string, unknown> = {}
  if (errorDetails !== undefined) {
    details.error = errorDetails
  }
  if (contextDetails !== undefined) {
    details.context = contextDetails
  }
  return details
}
