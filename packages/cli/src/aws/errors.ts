import { InstallerError } from '../diagnostic/error'
import { ProcessExecutionError } from '../process'
import { FileValidationError } from '../state/files'
import { SupervisedProcessError } from './child/supervise'
import { isRecord } from './guards'
import { originalCode } from './recovery'

export type AuthMode = 'login' | 'context'

class ExecutionFailure extends InstallerError {
  public readonly terminationConfirmed: boolean

  constructor(error: SupervisedProcessError, mode: AuthMode) {
    const login = mode === 'login'
    const code =
      error.kind === 'cancelled'
        ? 'COMMAND_CANCELLED'
        : error.kind === 'timeout'
          ? login
            ? 'AWS_LOGIN_TIMEOUT'
            : 'AWS_CONTEXT_TIMEOUT'
          : login
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

export function executionFailure(error: SupervisedProcessError, mode: AuthMode): InstallerError {
  return new ExecutionFailure(error, mode)
}

/**
 * Only failures at the protected-state boundary mean unsafe state. A bare
 * errno code is not enough, because network errors carry them too.
 */
function isStateAccessFailure(error: unknown): boolean {
  return (
    error instanceof FileValidationError ||
    error instanceof SyntaxError ||
    (isRecord(error) &&
      typeof error.code === 'string' &&
      (typeof error.path === 'string' || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'))
  )
}

export function stateFailure(error: unknown): InstallerError {
  if (error instanceof InstallerError) {
    return error
  }
  if (isStateAccessFailure(error)) {
    return new InstallerError({
      code: 'AWS_STATE_INVALID',
      retry: 'qiln aws status',
    })
  }
  return diagnostic(error)
}

/**
 * Command recovery retains approved diagnostic facts without carrying raw
 * filesystem, process, or provider errors into its reporting context.
 */
export function diagnostic(error: unknown): InstallerError {
  if (error instanceof InstallerError) {
    return error
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
  if (error instanceof SupervisedProcessError) {
    const codes = {
      start: 'AWS_TOOL_PROCESS_START_FAILED',
      cancelled: 'COMMAND_CANCELLED',
      timeout: 'AWS_TOOL_PROCESS_TIMEOUT',
      output: 'AWS_TOOL_PROCESS_OUTPUT_LIMIT',
      exit: 'AWS_TOOL_PROCESS_FAILED',
      lifecycle: 'AWS_TOOL_PROCESS_FAILED',
      protocol: 'AWS_TOOL_PROCESS_FAILED',
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

export function isCancellation(error: unknown): boolean {
  return (
    error instanceof InstallerError &&
    (error.code === 'COMMAND_CANCELLED' || originalCode(error) === 'COMMAND_CANCELLED')
  )
}
