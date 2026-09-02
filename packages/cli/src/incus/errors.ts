import { QilnInstallerError } from '../error'
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

const LOCAL_INCUS_ACCESS_ACTION =
  'Verify that Incus is running and that the invoking developer has approved access to the local Incus Unix socket, typically through incus-admin membership. Start a new login session after any group membership change.'

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
export function toInstallerError(error: unknown, context: IncusErrorContext): QilnInstallerError {
  if (error instanceof QilnInstallerError) {
    return error
  }
  if (error instanceof IncusOperationWaitTimeoutError) {
    return new QilnInstallerError({
      code: 'INCUS_OPERATION_INDETERMINATE',
      check: context.check,
      summary: 'The Incus operation did not reach a verified result before the local wait deadline.',
      observed: `The local wait for operation '${error.operationPath}' exceeded ${INSTALLER_SPEC.incus.operationWaitTimeoutMs}ms.`,
      reason:
        'The operation may still be running or may already have completed. Qiln must not infer success or failure and will not cancel it automatically.',
      operatorAction:
        'Inspect the Incus operation if needed, then rerun qiln up to reconcile from the actual local Incus state.',
      rerun: context.rerun,
      cause: error,
    })
  }
  if (error instanceof IncusOperationError) {
    return new QilnInstallerError({
      code: 'INCUS_OPERATION_FAILED',
      check: context.check,
      summary: 'The Incus background operation completed unsuccessfully.',
      observed: `Operation '${error.operationId}' completed with status code ${error.statusCode}.`,
      reason: 'The requested Incus mutation did not reach the required success state.',
      operatorAction:
        'Inspect the local Incus daemon and managed resource state manually, then rerun qiln up to reconcile without assuming rollback occurred.',
      rerun: context.rerun,
      cause: error,
    })
  }
  if (error instanceof IncusTransportError) {
    return new QilnInstallerError({
      code: 'INCUS_API_UNAVAILABLE',
      check: context.check,
      summary: 'The local Incus API could not be reached.',
      observed: `The local Unix-socket request to ${context.operation} did not complete through ${INSTALLER_SPEC.incus.socketPath}.`,
      reason:
        'Qiln cannot safely continue when it cannot obtain a complete view of the local Incus state. Qiln will not start services, invoke privilege escalation, or use a remote endpoint.',
      operatorAction: LOCAL_INCUS_ACCESS_ACTION,
      rerun: context.rerun,
      cause: error,
    })
  }
  if (error instanceof IncusProtocolError) {
    return new QilnInstallerError({
      code: 'INCUS_PROTOCOL_INCOMPATIBLE',
      check: context.check,
      summary: 'The local Incus API returned an incompatible response.',
      observed: `The response received while attempting to ${context.operation} did not match the expected Incus API contract.`,
      reason:
        'Qiln cannot safely continue when the local daemon response cannot be validated as a supported Incus API response.',
      operatorAction:
        'Verify that the configured local Unix socket belongs to a healthy supported Incus 7.x daemon, then inspect the daemon health manually.',
      rerun: context.rerun,
      cause: error,
    })
  }
  if (error instanceof IncusApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new QilnInstallerError({
        code: 'INCUS_ACCESS_DENIED',
        check: context.check,
        summary: 'The local Incus API denied the invoking developer.',
        observed: apiFailureObserved(error, context.operation),
        reason:
          'Qiln requires existing local Incus API authority from the invoking unprivileged developer and will not invoke sudo or another privileged helper.',
        operatorAction: LOCAL_INCUS_ACCESS_ACTION,
        rerun: context.rerun,
        cause: error,
      })
    }
    if (error.statusCode === 404) {
      return new QilnInstallerError({
        code: 'INCUS_UNEXPECTED_NOT_FOUND',
        check: context.check,
        summary: 'The local Incus API returned an unexpected not-found response.',
        observed: apiFailureObserved(error, context.operation),
        reason:
          'This request was required to inspect or mutate verified local installation state and was not an optional lookup.',
        operatorAction:
          'Inspect the local Incus resources and operation state manually, then rerun qiln up to reconcile from the actual provider state.',
        rerun: context.rerun,
        cause: error,
      })
    }
    if (error.statusCode === 412) {
      return new QilnInstallerError({
        code: 'INCUS_ETAG_CONFLICT',
        check: context.check,
        summary: 'The Incus resource changed during a guarded update.',
        observed: apiFailureObserved(error, context.operation),
        reason: 'Qiln must not replay a complete mutation body computed from stale provider state.',
        operatorAction:
          'Rerun qiln up so the resource can be re-read and revalidated. No stale update was replayed automatically.',
        rerun: context.rerun,
        cause: error,
      })
    }
    if (error.statusCode === 408 || error.statusCode >= 500) {
      return new QilnInstallerError({
        code: 'INCUS_API_UNAVAILABLE',
        check: context.check,
        summary: 'The local Incus API could not complete a required request.',
        observed: apiFailureObserved(error, context.operation),
        reason:
          'Qiln cannot safely continue after an unavailable or failed local API response because the resulting installation view may be incomplete.',
        operatorAction:
          'Inspect the local Incus daemon health, logs, Unix-socket availability, and managed resources before retrying.',
        rerun: context.rerun,
        cause: error,
      })
    }
    return new QilnInstallerError({
      code: 'INCUS_API_REQUEST_REJECTED',
      check: context.check,
      summary: 'The local Incus API rejected a required request.',
      observed: apiFailureObserved(error, context.operation),
      reason: 'Qiln cannot safely infer installer state after the authorized local Incus API rejects the request.',
      operatorAction: 'Inspect the local Incus daemon, project access, and managed resources manually before retrying.',
      rerun: context.rerun,
      cause: error,
    })
  }
  return new QilnInstallerError({
    code: 'INCUS_INSPECTION_FAILED',
    check: context.check,
    summary: 'A required local Incus operation failed unexpectedly.',
    observed: `Qiln could not complete the request to ${context.operation}.`,
    reason:
      'Qiln cannot safely continue after an unclassified local Incus failure because installation state may be incomplete or inconsistent.',
    operatorAction:
      'Inspect the local Incus daemon, Unix-socket access, managed resources, and Qiln installer version manually before retrying.',
    rerun: context.rerun,
    cause: error,
  })
}
