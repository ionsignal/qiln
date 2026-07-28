export const CaddyErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  API_ERROR: 'API_ERROR',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  CONFIGURATION_MISMATCH: 'CONFIGURATION_MISMATCH',
  UNSUPPORTED_CONFIGURATION: 'UNSUPPORTED_CONFIGURATION',
} as const

export type CaddyErrorCode = (typeof CaddyErrorCode)[keyof typeof CaddyErrorCode]

export const CaddyMutationOutcome = {
  NOT_ATTEMPTED: 'not_attempted',
  CONFIRMED_NOT_APPLIED: 'confirmed_not_applied',
  CONFIRMED_REJECTED: 'confirmed_rejected',
  UNKNOWN: 'unknown',
} as const

export type CaddyMutationOutcome = (typeof CaddyMutationOutcome)[keyof typeof CaddyMutationOutcome]

export interface CaddyErrorOptions {
  code: CaddyErrorCode
  outcome: CaddyMutationOutcome
  details?: unknown
}

/**
 * Represents a narrowly classified Caddy admin API failure.
 *
 * Later promotion and rollback executors use `outcome` alongside their durable
 * provider-intent evidence to decide whether a route operation can fail
 * normally or must become `cleanup_required`.
 */
export class CaddyError extends Error {
  public readonly code: CaddyErrorCode
  public readonly outcome: CaddyMutationOutcome
  public readonly details?: unknown

  constructor(message: string, options: CaddyErrorOptions) {
    super(message)
    this.name = 'CaddyError'
    this.code = options.code
    this.outcome = options.outcome
    this.details = options.details
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isCaddyError(value: unknown): value is CaddyError {
  return value instanceof CaddyError
}

export function caddyErrorDetailsFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof CaddyError) {
    const details: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      code: value.code,
      outcome: value.outcome,
    }
    if (value.details !== undefined) {
      details.details = value.details
    }
    return details
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }
  if (isRecord(value)) {
    return value
  }
  if (value === undefined || value === null) {
    return undefined
  }
  return {
    value,
  }
}
