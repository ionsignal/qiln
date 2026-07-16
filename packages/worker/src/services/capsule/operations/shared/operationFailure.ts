import {
  CapsuleOperationFailureSchema,
  CapsuleOperationStatus,
  type CapsuleOperationFailure,
  type CapsuleOperationStatusValue,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { toIsoTimestamp } from './timestamps'

export interface PersistedOperationFailureFields {
  id?: string
  status: CapsuleOperationStatusValue
  failedAt: Date | null
  failureCode: string | null
  failureMessage: string | null
}

const CLIENT_SAFE_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/
const DEFAULT_CLIENT_FAILURE_CODE = 'CAPSULE_OPERATION_FAILED'
const DEFAULT_CLIENT_CLEANUP_CODE = 'CAPSULE_OPERATION_CLEANUP_REQUIRED'

function clientSafeFailureCode(status: CapsuleOperationStatusValue, persistedCode: string): string {
  const normalizedCode = persistedCode.trim()
  if (CLIENT_SAFE_FAILURE_CODE_PATTERN.test(normalizedCode)) {
    return normalizedCode
  }
  return status === CapsuleOperationStatus.CLEANUP_REQUIRED ? DEFAULT_CLIENT_CLEANUP_CODE : DEFAULT_CLIENT_FAILURE_CODE
}

function clientSafeFailureMessage(status: CapsuleOperationStatusValue): string {
  if (status === CapsuleOperationStatus.CLEANUP_REQUIRED) {
    return 'This capsule operation requires manual cleanup and inspection.'
  }
  return 'The capsule operation failed.'
}

/**
 * Extracts a deliberately sanitized client-facing failure from persisted
 * operation fields.
 *
 * Raw persisted provider messages are not exposed because they may contain
 * provider diagnostics, host details, or paths. The durable code is retained
 * only when it fits the narrow client-safe code vocabulary.
 */
export function toClientSafeOperationFailure(operation: PersistedOperationFailureFields): CapsuleOperationFailure | null {
  const hasFailureData = operation.failedAt !== null || operation.failureCode !== null || operation.failureMessage !== null
  if (!hasFailureData) {
    return null
  }
  if (operation.failedAt === null || operation.failureCode === null || operation.failureMessage === null) {
    throw new IncusError('Capsule operation has incomplete persisted failure fields.', 'API_ERROR', {
      operationId: operation.id,
      operationStatus: operation.status,
      hasFailedAt: operation.failedAt !== null,
      hasFailureCode: operation.failureCode !== null,
      hasFailureMessage: operation.failureMessage !== null,
    })
  }
  return CapsuleOperationFailureSchema.parse({
    code: clientSafeFailureCode(operation.status, operation.failureCode),
    message: clientSafeFailureMessage(operation.status),
    occurredAt: toIsoTimestamp(operation.failedAt, 'failedAt', {
      entity: 'capsule operation',
      entityId: operation.id,
    }),
  })
}
