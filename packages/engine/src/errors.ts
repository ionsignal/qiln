/**
 * Custom Error for Incus API and Transport failures.
 */
export class IncusError extends Error {
  constructor(
    message: string,
    public readonly code: 'TRANSPORT_ERROR' | 'API_ERROR' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' = 'API_ERROR',
    public readonly details?: Record<string, any>,
  ) {
    super(message)
    this.name = 'IncusError'
  }
}

/**
 * Safely traverses Drizzle's error wrapping to identify Postgres unique constraint violations.
 * @param err The unknown error object caught in a try/catch.
 * @param constraintName Optional specific constraint name to check against.
 * @returns True if it's a 23505 violation matching the constraint.
 */
export function isUniqueConstraintViolation(err: unknown, constraintName?: string): boolean {
  if (!err || typeof err !== 'object') return false
  const error = err as any
  const code = error.code || error.cause?.code
  const constraint = error.constraint_name || error.cause?.constraint_name
  if (code === '23505') {
    if (constraintName) {
      return constraint === constraintName
    }
    return true
  }
  return false
}
