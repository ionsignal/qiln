import type { Action } from './graph'
import type { StepAction } from '../../remote/zfs/spec'

const WAITING_INTERVAL_MS = 10_000

export interface Place {
  position: number
  total: number
}

export interface KeyTask {
  kind: 'key'
}

export interface StepTask extends Place {
  kind: 'step'
  action: Action
  slot: number
}

export interface HealthTask {
  kind: 'health'
}

export interface HostKeyTask {
  kind: 'hostkey'
}

export interface ZfsTask {
  kind: 'zfs'
  action: StepAction
}

/**
 * Key generation, the AWS health check, the host-key read, and a ZFS
 * preparation step are stages of their own, not actions of the deployment
 * graph, so each is a task of its own.
 */
export type ProgressTask = KeyTask | StepTask | HealthTask | HostKeyTask | ZfsTask

/**
 * `working` precedes the activity, `waiting` repeats while it lasts, and
 * `verified` follows only after the observation and its persistence succeeded.
 * No event states that an activity failed or was rolled back.
 */
export type ProgressEvent =
  | { phase: 'working' | 'verified'; task: ProgressTask }
  | { phase: 'waiting'; task: ProgressTask; elapsedMs: number }

export type ProgressSink = (event: ProgressEvent) => void

export function notify(sink: ProgressSink | undefined, event: ProgressEvent): void {
  try {
    sink?.(event)
  } catch {
    // Intentionally ignored.
  }
}

/**
 * Emits throttled elapsed-time events while `run` is pending. The timer is
 * always cleared, so it cannot outlive the operation or hold the process open.
 */
export async function withWaiting<T>(
  sink: ProgressSink | undefined,
  task: ProgressTask,
  run: () => Promise<T>,
): Promise<T> {
  if (sink === undefined) {
    return await run()
  }
  const started = Date.now()
  const timer = setInterval(
    () => notify(sink, { phase: 'waiting', task, elapsedMs: Date.now() - started }),
    WAITING_INTERVAL_MS,
  )
  timer.unref()
  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
}
