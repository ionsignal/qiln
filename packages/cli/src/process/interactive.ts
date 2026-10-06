import { spawn } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { InstallerError } from '../diagnostic/error'
import { AuthenticationExecutionError, observeAuthentication } from '../process'
import { executionFailure } from '../aws/errors'

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
  try {
    const child = spawn(executable, [...argumentsList], {
      env: options.environment,
      shell: false,
      stdio: 'inherit',
    })
    await observeAuthentication(child, {
      mode: 'interactive',
      command: basename(executable),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      group: false,
    })
  } catch (error: unknown) {
    if (error instanceof AuthenticationExecutionError) {
      throw executionFailure(error)
    }
    throw error
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw)
    }
  }
}
