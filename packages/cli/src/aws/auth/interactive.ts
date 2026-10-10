import { spawn } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { interruptedBySignal, SupervisedProcessError, supervise } from '../child/supervise'
import { executionFailure } from '../errors'

export interface InteractiveOptions {
  environment: NodeJS.ProcessEnv
  signal: AbortSignal
  timeoutMs: number
}

export async function runInteractive(
  executable: string,
  argumentsList: readonly string[],
  options: InteractiveOptions,
): Promise<void> {
  if (!isAbsolute(executable)) {
    throw new RangeError('Interactive processes require an absolute executable path.')
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('Interactive process deadlines must be positive safe integers.')
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new InstallerError({
      code: 'INTERACTIVE_TERMINAL_REQUIRED',
      retry: 'qiln aws connect',
    })
  }
  if (options.signal.aborted) {
    throw new InstallerError({
      code: 'COMMAND_CANCELLED',
    })
  }
  const wasRaw = process.stdin.isRaw
  let restored = true
  try {
    const child = spawn(executable, [...argumentsList], {
      env: options.environment,
      shell: false,
      stdio: 'inherit',
    })
    // Interactive login keeps the terminal's process relationship, so only the
    // direct child's termination is confirmed.
    await supervise(child, {
      command: basename(executable),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      group: false,
      unrefUnconfirmed: true,
      classifyExit: interruptedBySignal,
    }).done
  } catch (error: unknown) {
    if (error instanceof SupervisedProcessError) {
      throw executionFailure(error, 'login')
    }
    throw error
  } finally {
    // A restoration failure must not replace the login failure, which carries
    // the termination evidence that recovery relies on.
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw)
      }
    } catch {
      restored = false
    }
  }
  if (!restored) {
    throw new InstallerError({
      code: 'AWS_LOGIN_FAILED',
      facts: [['Observed', 'The terminal input mode could not be restored after login completed.']],
      retry: 'qiln aws connect',
    })
  }
}
