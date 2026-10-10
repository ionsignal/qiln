import { fork } from 'node:child_process'
import { checkCancellation } from '../../terminal/prompts'
import { executionFailure } from '../errors'
import { AWS_SPEC } from '../spec'
import { interruptedBySignal, SupervisedProcessError, supervise } from './supervise'

export interface ChildEvidence {
  accept(message: unknown): boolean
  retain(message: unknown): Promise<object>
}

export interface ChildOptions {
  terminal?: boolean
  timeoutMs?: number
  evidence?: ChildEvidence
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
    let evidenceSeen = false
    let retaining = false
    let evidenceWork: Promise<void> | undefined
    let failProtocol: (() => void) | undefined
    try {
      await supervise(child, {
        command: 'AWS credential context',
        signal,
        timeoutMs: options.timeoutMs ?? AWS_SPEC.requestTimeoutMs,
        group: true,
        unrefUnconfirmed: true,
        classifyExit: interruptedBySignal,
        onSpawn(fail) {
          failProtocol = () => fail('protocol')
          child.send(input, error => {
            if (error) {
              fail('protocol')
            }
          })
        },
        onMessage(message) {
          if (result !== undefined || retaining) {
            return false
          }
          if (validate(message)) {
            result = message
            return true
          }
          const evidence = options.evidence
          if (!evidence || evidenceSeen || !evidence.accept(message)) {
            return false
          }
          evidenceSeen = true
          retaining = true
          evidenceWork = Promise.resolve()
            .then(() => evidence.retain(message))
            .then(acknowledgment => {
              retaining = false
              if (!child.connected) {
                failProtocol?.()
                return
              }
              child.send(acknowledgment, error => {
                if (error) {
                  failProtocol?.()
                }
              })
            })
            .catch(() => {
              retaining = false
              failProtocol?.()
            })
          return true
        },
        accept: () => result !== undefined && !retaining,
      }).done
    } finally {
      // Evidence persistence belongs to the parent's locked transaction. Drain
      // it before recovery can remove inputs or release the connection lock.
      await evidenceWork
    }
    if (result === undefined) {
      throw new SupervisedProcessError('protocol', 'AWS credential context', true)
    }
    // Waiting for close, rather than just the reply, terminates the credential
    // context before callers approve, persist, or remove authentication state.
    checkCancellation(signal)
    return result
  } catch (error: unknown) {
    if (error instanceof SupervisedProcessError) {
      throw executionFailure(error, 'context')
    }
    throw error
  }
}
