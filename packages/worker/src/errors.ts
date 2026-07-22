/**
 * Custom Error for Incus API, validation, and transport failures.
 */
export class IncusError extends Error {
  constructor(
    message: string,
    public readonly code:
      'TRANSPORT_ERROR' | 'API_ERROR' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' = 'API_ERROR',
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'IncusError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const property = value[key]
  return typeof property === 'string' ? property : undefined
}

function readCause(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined
  }
  return value.cause
}

export function readIncusErrorDetailCode(error: IncusError): string | number | undefined {
  if (!isRecord(error.details)) {
    return undefined
  }
  const code = error.details.code
  if (typeof code === 'string' || typeof code === 'number') {
    return code
  }
  return undefined
}

/**
 * Safely traverses Drizzle's error wrapping to identify Postgres unique
 * constraint violations.
 *
 * @param err The unknown error object caught in a try/catch.
 * @param constraintName Optional specific constraint name to check against.
 * @returns True if it is a 23505 violation matching the optional constraint.
 */
export function isUniqueConstraintViolation(err: unknown, constraintName?: string): boolean {
  const cause = readCause(err)
  const code = readStringProperty(err, 'code') ?? readStringProperty(cause, 'code')
  const constraint = readStringProperty(err, 'constraint_name') ?? readStringProperty(cause, 'constraint_name')
  if (code !== '23505') {
    return false
  }
  if (constraintName) {
    return constraint === constraintName
  }
  return true
}
