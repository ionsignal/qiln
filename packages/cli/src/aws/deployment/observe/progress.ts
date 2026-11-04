import type { Action } from '../graph'
import type { IncusAction } from '../../../host/incus/spec'
import type { StepAction } from '../../../host/zfs/spec'

export interface LaunchAttempt {
  number: number
  total: number
  zone: string
}

export interface Place {
  position: number
  total: number
  attempt?: LaunchAttempt
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

export interface IncusTask {
  kind: 'incus'
  action: IncusAction
}

/**
 * Key generation, the AWS health check, the host-key read, and a ZFS or Incus
 * preparation step are stages of their own, not actions of the deployment
 * graph, so each is a task of its own.
 */
export type ProgressTask = KeyTask | StepTask | HealthTask | HostKeyTask | ZfsTask | IncusTask

/**
 * `working` precedes the activity, and `verified` follows only after the
 * observation and its persistence succeeded. `declined` is the one event that
 * reports a failure: AWS definitely refused one launch attempt for lack of
 * capacity, it was durably recorded, and the next approved zone is tried. No
 * other event states that an activity failed or was rolled back.
 */
export interface ProgressEvent {
  phase: 'working' | 'verified' | 'declined'
  task: ProgressTask
}

export type ProgressSink = (event: ProgressEvent) => void

export function notify(sink: ProgressSink | undefined, event: ProgressEvent): void {
  try {
    sink?.(event)
  } catch {
    // Intentionally ignored.
  }
}
