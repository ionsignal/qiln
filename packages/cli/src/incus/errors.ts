import { QilnInstallerError } from '../error'
import { INSTALLER_SPEC } from '../install/spec'
import { IncusApiError, IncusProtocolError, IncusTransportError } from './client'

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
 * optional-resource behavior, particularly explicit 404 handling.
 */
export function isIncusApiStatus(error: unknown, statusCode: number): error is IncusApiError {
  return error instanceof IncusApiError && error.statusCode === statusCode
}

/**
 * Converts unhandled local Incus client failures into non-secret installer
 * diagnostics. Expected resource absence remains a caller-owned decision.
 */
export function toInstallerError(error: unknown, context: IncusErrorContext): QilnInstallerError {
  if (error instanceof QilnInstallerError) {
    return error
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
          'This request was required to inspect the local installation state and was not an optional resource lookup that Qiln may treat as absent.',
        operatorAction:
          'Inspect the local Incus daemon and its managed resources manually. Do not ask Qiln to repair or recreate unverified resources automatically.',
        rerun: context.rerun,
        cause: error,
      })
    }
    if (error.statusCode === 408 || error.statusCode >= 500) {
      return new QilnInstallerError({
        code: 'INCUS_API_UNAVAILABLE',
        check: context.check,
        summary: 'The local Incus API could not complete a required inspection request.',
        observed: apiFailureObserved(error, context.operation),
        reason:
          'Qiln cannot safely continue after an unavailable or failed local API response because the resulting installation view may be incomplete.',
        operatorAction:
          'Inspect the local Incus daemon health, logs, and Unix-socket availability manually. Confirm the daemon is healthy before retrying.',
        rerun: context.rerun,
        cause: error,
      })
    }
    return new QilnInstallerError({
      code: 'INCUS_API_REQUEST_REJECTED',
      check: context.check,
      summary: 'The local Incus API rejected a required inspection request.',
      observed: apiFailureObserved(error, context.operation),
      reason:
        'Qiln cannot safely infer installer state after the authorized local Incus API rejects a required read-only preflight request.',
      operatorAction:
        'Inspect the local Incus daemon configuration, project access, and managed resource state manually. Resolve the reported condition without asking Qiln to overwrite existing resources.',
      rerun: context.rerun,
      cause: error,
    })
  }
  return new QilnInstallerError({
    code: 'INCUS_INSPECTION_FAILED',
    check: context.check,
    summary: 'A required local Incus inspection failed unexpectedly.',
    observed: `Qiln could not complete the request to ${context.operation}.`,
    reason:
      'Qiln cannot safely continue after an unclassified local Incus inspection failure because installation state may be incomplete or inconsistent.',
    operatorAction:
      'Inspect the local Incus daemon, Unix-socket access, and Qiln installer version manually before retrying. Do not infer that any installation action completed.',
    rerun: context.rerun,
    cause: error,
  })
}
