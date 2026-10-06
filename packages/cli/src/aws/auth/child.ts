import { fork } from 'node:child_process'
import { AuthenticationExecutionError, observeAuthentication } from '../../process'
import { checkCancellation } from '../../terminal/prompts'
import { executionFailure } from '../errors'
import { AWS_SPEC } from '../spec'

export interface ChildOptions {
  terminal?: boolean
  timeoutMs?: number
}

/**
 * Only the password request inherits terminal output. All other child output is
 * discarded, and every IPC reply must satisfy its caller's allowlist.
 */
export async function request<T>(
  entry: string,
  environment: NodeJS.ProcessEnv,
  input: object,
  validate: (message: unknown) => message is T,
  signal: AbortSignal,
  options: ChildOptions = {},
): Promise<T> {
  checkCancellation(signal)
  try {
    const child = fork(new URL(entry, import.meta.url), [], {
      execPath: process.execPath,
      execArgv: [],
      env: environment,
      detached: true,
      serialization: 'json',
      stdio: ['ignore', options.terminal ? 'inherit' : 'ignore', 'ignore', 'ipc'],
    })
    let result: T | undefined
    await observeAuthentication(child, {
      mode: 'ipc',
      command: 'AWS credential context',
      signal,
      timeoutMs: options.timeoutMs ?? AWS_SPEC.requestTimeoutMs,
      group: true,
      onSpawn(fail) {
        child.send(input, error => {
          if (error) {
            fail()
          }
        })
      },
      onMessage(message) {
        if (result !== undefined || !validate(message)) {
          return false
        }
        result = message
        return true
      },
      accept: () => result !== undefined,
    })
    if (result === undefined) {
      throw new AuthenticationExecutionError('protocol', 'ipc', 'AWS credential context', true)
    }
    // Waiting for close, rather than just the reply, terminates the credential
    // context before callers approve, persist, or remove authentication state.
    checkCancellation(signal)
    return result
  } catch (error: unknown) {
    if (error instanceof AuthenticationExecutionError) {
      throw executionFailure(error)
    }
    throw error
  }
}
