import type { LiveRow, Outcome, Reporter } from '../../terminal/reporter'
import type { StepText } from '../aws/deployment/prepare/steps'

export interface StepEvent<Action extends string> {
  phase: 'working' | 'verified'
  action: Action
}

export interface StepResult {
  outcome: Outcome
  detail: string
}

/**
 * `working` starts a live row and `verified` finishes it, so a row is only
 * permanent once the observation and its persistence succeeded. A failure
 * leaves the live row to the diagnostic, which clears it.
 */
export function stepSink<Action extends string>(
  reporter: Reporter,
  steps: Record<Action, StepText>,
  results: Record<Action, StepResult>,
): (event: StepEvent<Action>) => void {
  let live: LiveRow | null = null
  return ({ phase, action }) => {
    const { short, label } = steps[action]
    if (phase === 'working') {
      live = reporter.live(short, label)
      return
    }
    const { outcome, detail } = results[action]
    if (live === null) {
      reporter.row(outcome, short, detail)
    } else {
      live.finish(outcome, detail)
    }
    live = null
  }
}
