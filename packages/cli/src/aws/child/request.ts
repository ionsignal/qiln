import { fork } from 'node:child_process'
import type { z } from 'zod'
import { checkCancellation } from '../../terminal/prompts'
import { executionFailure } from '../errors'
import { accept } from '../primitives'
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
  keepReply?: boolean
}

function cancelledAfterClose(error: unknown): boolean {
  return error instanceof SupervisedProcessError && error.kind === 'cancelled' && error.terminationConfirmed
}

/**
 * Only the password request inherits terminal output. All other child output is
 * discarded, and every IPC reply must satisfy its caller's schema.
 */
export async function request<S extends z.ZodType>(
  entry: string,
  environment: NodeJS.ProcessEnv,
  input: object,
  schema: S,
  signal: AbortSignal,
  options: ChildOptions = {},
): Promise<z.output<S>> {
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
    let result: z.output<S> | undefined
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
          const reply = accept(schema, message)
          if (reply !== null) {
            result = reply
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
    } catch (error: unknown) {
      // Cancellation after the reply, with the child confirmed terminated, does
      // not undo the reply. Any other failure keeps its own classification.
      if (!(options.keepReply && result !== undefined && cancelledAfterClose(error))) {
        throw error
      }
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
    // A caller that keeps the reply checks the signal after accounting for it.
    if (!options.keepReply) {
      checkCancellation(signal)
    }
    return result
  } catch (error: unknown) {
    if (error instanceof SupervisedProcessError) {
      throw executionFailure(error, 'context')
    }
    throw error
  }
}
