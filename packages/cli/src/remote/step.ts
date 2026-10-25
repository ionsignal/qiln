import { SshError } from '../ssh/failure'
import type { Remote } from '../ssh/connections'

/**
 * - returned: exited zero. This is not verified until a fresh inspection agrees.
 * - refused: an authored refusal, or a connection that ended before dispatch.
 *   The whole step had no effect.
 * - uncertain: anything else. A nonzero exit does not show that nothing
 *   changed, and a step cut off after dispatch may have run partly or fully.
 *   `exitCode` is null when no exit status was reported.
 *
 * `cause` carries the SSH failure, if any, so cancellation can be rethrown.
 */
export type StepOutcome =
  | { kind: 'returned' }
  | { kind: 'refused'; reason: string; cause: SshError | null }
  | { kind: 'uncertain'; reason: string; exitCode: number | null; cause: SshError | null }

/**
 * The deadline and output bound of one step, the wording of each exit code that
 * refuses before any effect, and the range of exit codes that mean a refusal.
 */
export interface StepRun {
  timeoutMs: number
  maxOutputBytes: number
  refusals: Readonly<Record<number, string>>
  refusalCodes: { first: number; last: number }
}

/**
 * Runs one authored command and classifies how it ended. A failed SSH channel
 * ends the connection, so nothing is retried here.
 */
export async function runStep(remote: Remote, command: string, run: StepRun): Promise<StepOutcome> {
  const { first, last } = run.refusalCodes
  try {
    const { exitCode } = await remote.exec(command, {
      timeoutMs: run.timeoutMs,
      maxOutputBytes: run.maxOutputBytes,
    })
    if (exitCode === 0) {
      return { kind: 'returned' }
    }
    if (exitCode >= first && exitCode <= last) {
      return {
        kind: 'refused',
        reason: run.refusals[exitCode] ?? 'The script refused before changing anything.',
        cause: null,
      }
    }
    return { kind: 'uncertain', reason: `The script exited with code ${exitCode}.`, exitCode, cause: null }
  } catch (error: unknown) {
    if (!(error instanceof SshError)) {
      throw error
    }
    return error.remoteStarted
      ? {
          kind: 'uncertain',
          reason: 'The connection or remote operation did not complete reliably.',
          exitCode: null,
          cause: error,
        }
      : { kind: 'refused', reason: 'The connection ended before the step was dispatched.', cause: error }
  }
}
