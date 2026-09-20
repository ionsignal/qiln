import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from '../install/spec'
import {
  IncusApiError,
  IncusOperationError,
  IncusOperationWaitTimeoutError,
  IncusProtocolError,
  IncusTransportError,
} from './client'

export interface IncusErrorContext {
  check: string
  operation: string
  rerun: string
}



function apiFailureObserved(error: IncusApiError, operation: string): string {
  return `Incus returned HTTP ${error.statusCode} with API error code ${error.errorCode} while attempting to ${operation}.`
}

/**
 * Identifies an expected Incus API status so callers can retain ownership of
 * optional-resource and guarded-update behavior.
 */
export function isIncusApiStatus(error: unknown, statusCode: number): error is IncusApiError {
  return error instanceof IncusApiError && error.statusCode === statusCode
}

/**
 * Converts unhandled local Incus client failures into non-secret installer
 * diagnostics. Expected resource absence and guarded update conflicts remain
 * caller-owned decisions.
 */
export function toInstallerError(error: unknown, context: IncusErrorContext): InstallerError {
  if (error instanceof InstallerError) {
    return error
  }
  if (error instanceof IncusOperationWaitTimeoutError) {
    return new InstallerError({
      code: 'INCUS_OPERATION_INDETERMINATE',
      facts: [['Observed', `The local wait for operation '${error.operationPath}' exceeded ${INSTALLER_SPEC.incus.operationWaitTimeoutMs}ms.`]],
      retry: context.rerun,
    })
  }
  if (error instanceof IncusOperationError) {
    return new InstallerError({
      code: 'INCUS_OPERATION_FAILED',
      facts: [['Observed', `Operation '${error.operationId}' completed with status code ${error.statusCode}.`]],
      retry: context.rerun,
    })
  }
  if (error instanceof IncusTransportError) {
    return new InstallerError({
      code: 'INCUS_API_UNAVAILABLE',
      facts: [['Observed', `The local Unix-socket request to ${context.operation} did not complete through ${INSTALLER_SPEC.incus.socketPath}.`]],
      retry: context.rerun,
    })
  }
  if (error instanceof IncusProtocolError) {
    return new InstallerError({
      code: 'INCUS_PROTOCOL_INCOMPATIBLE',
      facts: [['Observed', `The response received while attempting to ${context.operation} did not match the expected Incus API contract.`]],
      retry: context.rerun,
    })
  }
  if (error instanceof IncusApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new InstallerError({
        code: 'INCUS_ACCESS_DENIED',
        facts: [['Observed', apiFailureObserved(error, context.operation)]],
        retry: context.rerun,
      })
    }
    if (error.statusCode === 404) {
      return new InstallerError({
        code: 'INCUS_UNEXPECTED_NOT_FOUND',
        facts: [['Observed', apiFailureObserved(error, context.operation)]],
        retry: context.rerun,
      })
    }
    if (error.statusCode === 412) {
      return new InstallerError({
        code: 'INCUS_ETAG_CONFLICT',
        facts: [['Observed', apiFailureObserved(error, context.operation)]],
        retry: context.rerun,
      })
    }
    if (error.statusCode === 408 || error.statusCode >= 500) {
      return new InstallerError({
        code: 'INCUS_API_UNAVAILABLE',
        facts: [['Observed', apiFailureObserved(error, context.operation)]],
        retry: context.rerun,
      })
    }
    return new InstallerError({
      code: 'INCUS_API_REQUEST_REJECTED',
      facts: [['Observed', apiFailureObserved(error, context.operation)]],
      retry: context.rerun,
    })
  }
  return new InstallerError({
    code: 'INCUS_INSPECTION_FAILED',
    facts: [['Observed', `Qiln could not complete the request to ${context.operation}.`]],
    retry: context.rerun,
  })
}
