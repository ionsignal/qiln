import { catalog } from '../diagnostic/catalog'
import { InstallerError, type DiagnosticFact, type InstallerErrorCode } from '../diagnostic/error'
import { AuthenticationExecutionError, ProcessExecutionError, SetupExecutionError } from '../process'
import { isFailureCode, isRecord, type AwsFailureCode } from './types'

export interface RecoveryOutcomes {
  termination: boolean
  cleanup: boolean
  journal: boolean
}

class RecoveryError extends InstallerError {
  public readonly failureCode: InstallerErrorCode
  public readonly terminationConfirmed: boolean

  constructor(
    failure: InstallerError,
    outcomes: RecoveryOutcomes,
    retry: string,
    bootstrapFacts?: readonly DiagnosticFact[],
  ) {
    const complete = outcomes.termination && outcomes.cleanup && outcomes.journal
    const recoveryCode = bootstrapFacts === undefined ? 'AWS_RECOVERY_REQUIRED' : 'AWS_BOOTSTRAP_RECOVERY_REQUIRED'
    super({
      code: complete ? failure.code : recoveryCode,
      facts: [
        ...(!complete
          ? ([['Original failure', `${originalCode(failure)}: ${catalog[originalCode(failure)].title}`]] as const)
          : []),
        ...failure.facts,
        ...(bootstrapFacts ?? []),
        ['Authentication termination', outcomes.termination ? 'confirmed' : 'not confirmed'],
        ['Authentication cleanup', outcomes.cleanup ? 'completed' : 'not confirmed'],
        ['Failure journal', outcomes.journal ? 'persisted' : 'persistence not confirmed'],
        ...(!outcomes.termination
          ? ([['Connection lock', 'retained; potentially active authentication inputs were not removed']] as const)
          : []),
      ],
      retry: complete ? (failure.retry ?? retry) : retry,
    })
    this.failureCode = originalCode(failure)
    this.terminationConfirmed = outcomes.termination
  }
}

class ExecutionFailure extends InstallerError {
  public readonly terminationConfirmed: boolean

  constructor(error: AuthenticationExecutionError) {
    const interactive = error.mode === 'interactive'
    const code =
      error.kind === 'cancelled'
        ? 'COMMAND_CANCELLED'
        : error.kind === 'timeout'
          ? interactive
            ? 'AWS_LOGIN_TIMEOUT'
            : 'AWS_CONTEXT_TIMEOUT'
          : interactive
            ? 'AWS_LOGIN_FAILED'
            : 'AWS_CONTEXT_FAILED'
    super({
      code,
      facts: [
        ['Failure category', error.kind],
        ['Authentication termination', error.terminationConfirmed ? 'confirmed' : 'not confirmed'],
      ],
      retry: 'qiln aws connect',
    })
    this.terminationConfirmed = error.terminationConfirmed
  }
}

class LockRecoveryError extends InstallerError {
  public readonly failureCode: InstallerErrorCode
  public readonly terminationConfirmed: boolean

  constructor(failure: InstallerError) {
    super({
      code: 'AWS_RECOVERY_REQUIRED',
      facts: [
        ['Original failure', `${originalCode(failure)}: ${catalog[originalCode(failure)].title}`],
        ...failure.facts,
        ['Connection lock', 'release or directory synchronization not confirmed'],
      ],
      retry: failure.retry ?? 'qiln aws status',
    })
    this.failureCode = originalCode(failure)
    this.terminationConfirmed = terminationConfirmed(failure)
  }
}

export function originalCode(error: InstallerError): InstallerErrorCode {
  if (isRecord(error) && typeof error.failureCode === 'string' && Object.hasOwn(catalog, error.failureCode)) {
    return error.failureCode as InstallerErrorCode
  }
  return error.code
}

export function terminationConfirmed(error: unknown): boolean {
  return !(isRecord(error) && 'terminationConfirmed' in error && error.terminationConfirmed === false)
}

export function executionFailure(error: AuthenticationExecutionError): InstallerError {
  return new ExecutionFailure(error)
}

export function lockRecovery(failure: InstallerError): InstallerError {
  return new LockRecoveryError(failure)
}

export function bootstrapRecovery(
  failure: InstallerError,
  outcomes: RecoveryOutcomes,
  facts: readonly DiagnosticFact[],
): InstallerError {
  return new RecoveryError(failure, outcomes, 'qiln aws --help', facts)
}

export function isErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

export function stateFailure(error: unknown): InstallerError {
  if (error instanceof InstallerError) {
    return error
  }
  return new InstallerError({
    code: 'AWS_STATE_INVALID',
    retry: 'qiln aws status',
  })
}

/**
 * Only allowlisted classifications leave the credential process. Provider
 * messages, request objects, and credential values are never returned.
 */
export function classify(error: unknown): AwsFailureCode {
  if (error instanceof InstallerError && isFailureCode(error.code)) {
    return error.code
  }
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : ''
  switch (name) {
    case 'CredentialsProviderError':
      return 'AWS_AUTH_FAILED'
    case 'ExpiredToken':
    case 'ExpiredTokenException':
      return 'AWS_AUTH_EXPIRED'
    case 'InvalidClientTokenId':
    case 'UnrecognizedClientException':
      return 'AWS_AUTH_FAILED'
    case 'AccessDenied':
    case 'AccessDeniedException':
      return 'AWS_ACCESS_DENIED'
    case 'EntityAlreadyExistsException':
      return 'AWS_BOOTSTRAP_CONFLICT'
    case 'PasswordPolicyViolationException':
      return 'AWS_BOOTSTRAP_PASSWORD_REJECTED'
    case 'NoSuchEntityException':
      return 'AWS_BOOTSTRAP_INSPECTION_FAILED'
    default:
      return 'AWS_REQUEST_FAILED'
  }
}

/**
 * Command recovery retains approved diagnostic facts without carrying raw
 * filesystem, process, or provider errors into its reporting context.
 */
export function diagnostic(error: unknown): InstallerError {
  if (error instanceof InstallerError) {
    return error
  }
  if (error instanceof AuthenticationExecutionError) {
    return executionFailure(error)
  }
  if (error instanceof ProcessExecutionError) {
    return new InstallerError({
      code: 'AWS_CLI_CHECK_FAILED',
      facts: [
        ['Command', error.command],
        ['Failure category', error.kind],
      ],
      retry: 'qiln aws connect',
    })
  }
  return new InstallerError({
    code: 'INTERNAL_ERROR',
    retry: 'qiln aws connect',
  })
}

export function recovery(failure: InstallerError, outcomes: RecoveryOutcomes, retry: string): InstallerError {
  return new RecoveryError(failure, outcomes, retry)
}

export interface ToolRecoveryOutcomes {
  termination: boolean
  cleanup: boolean | 'not-required'
  persistence: boolean | 'not-required'
  lock: boolean | 'not-required'
}

function outcome(value: boolean | 'not-required'): string {
  return value === 'not-required' ? 'not required' : value ? 'completed' : 'not confirmed'
}

class ToolRecoveryError extends InstallerError {
  public readonly failureCode: InstallerErrorCode

  constructor(failure: InstallerError, outcomes: ToolRecoveryOutcomes, destination: string) {
    const complete = Object.values(outcomes).every(value => value !== false)
    super({
      code: complete ? failure.code : 'AWS_TOOL_RECOVERY_REQUIRED',
      facts: [
        ...(!complete ? ([['Original failure', `${failure.code}: ${catalog[failure.code].title}`]] as const) : []),
        ...failure.facts,
        ['Tool location', destination],
        ['Process termination', outcomes.termination ? 'confirmed' : 'not confirmed'],
        ['Workspace cleanup', outcome(outcomes.cleanup)],
        ['Failure record', outcome(outcomes.persistence)],
        ['Tool lock release', outcomes.lock === false ? 'retained or release not confirmed' : outcome(outcomes.lock)],
      ],
      retry: failure.retry ?? 'qiln aws connect',
    })
    this.failureCode = failure.code
  }
}

export function toolDiagnostic(error: unknown): InstallerError {
  if (error instanceof InstallerError) {
    return error.code === 'AWS_STATE_INVALID'
      ? new InstallerError({
          code: 'AWS_TOOL_STATE_INVALID',
          retry: 'qiln aws connect',
        })
      : error
  }
  if (isRecord(error) && error.name === 'DownloadError' && error.failure instanceof InstallerError) {
    return error.failure
  }
  if (error instanceof SetupExecutionError) {
    const codes = {
      start: 'AWS_TOOL_PROCESS_START_FAILED',
      cancelled: 'COMMAND_CANCELLED',
      timeout: 'AWS_TOOL_PROCESS_TIMEOUT',
      output: 'AWS_TOOL_PROCESS_OUTPUT_LIMIT',
      exit: 'AWS_TOOL_PROCESS_FAILED',
      lifecycle: 'AWS_TOOL_PROCESS_FAILED',
    } as const
    return new InstallerError({
      code: codes[error.kind],
      facts: [
        ['Command', error.command],
        ['Failure category', error.kind],
        ['Process termination', error.terminationConfirmed ? 'confirmed' : 'not confirmed'],
      ],
      retry: 'qiln aws connect',
    })
  }
  return new InstallerError({
    code: 'AWS_TOOL_INSTALL_FAILED',
    retry: 'qiln aws connect',
  })
}

export function toolRecovery(
  failure: InstallerError,
  outcomes: ToolRecoveryOutcomes,
  destination: string,
): InstallerError {
  return new ToolRecoveryError(failure, outcomes, destination)
}

export function isCancellation(error: unknown): boolean {
  return (
    error instanceof InstallerError &&
    (error.code === 'COMMAND_CANCELLED' || originalCode(error) === 'COMMAND_CANCELLED')
  )
}
