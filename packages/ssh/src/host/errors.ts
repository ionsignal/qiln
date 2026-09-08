import { GlobalError, GlobalErrorCode } from '@qiln/core/server'

export class SshHostPolicyError extends GlobalError {
  constructor(message: string, code: GlobalErrorCode, details?: Record<string, unknown>) {
    super(message, code, details)
    this.name = 'SshHostPolicyError'
  }
}

export function sshBadRequest(message: string, details?: Record<string, unknown>): SshHostPolicyError {
  return new SshHostPolicyError(message, GlobalErrorCode.BAD_REQUEST, details)
}

export function sshForbidden(message: string, details?: Record<string, unknown>): SshHostPolicyError {
  return new SshHostPolicyError(message, GlobalErrorCode.FORBIDDEN, details)
}

export function sshNotFound(message: string, details?: Record<string, unknown>): SshHostPolicyError {
  return new SshHostPolicyError(message, GlobalErrorCode.NOT_FOUND, details)
}

export function sshConflict(message: string, details?: Record<string, unknown>): SshHostPolicyError {
  return new SshHostPolicyError(message, GlobalErrorCode.CONFLICT, details)
}

export function sshInternal(message: string, details?: Record<string, unknown>): SshHostPolicyError {
  return new SshHostPolicyError(message, GlobalErrorCode.INTERNAL_ERROR, details)
}

export function toIsoTimestamp(value: Date, field: string, entityId: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw sshInternal('Durable SSH state contains an invalid timestamp.', {
      field,
      entityId,
    })
  }

  return value.toISOString()
}

export function toNullableIsoTimestamp(value: Date | null, field: string, entityId: string): string | null {
  return value === null ? null : toIsoTimestamp(value, field, entityId)
}
