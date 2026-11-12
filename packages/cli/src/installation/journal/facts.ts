import * as journal from '../../journal/step'
import { InstallerError } from '../../diagnostic/error'

/**
 * The shared shape of configuration and startup evidence.
 */
type Evidence<Step extends journal.JournalStep = journal.JournalStep> = { steps: readonly Step[] } | null

/**
 * Steps whose effect is unknown and which only an operator can resolve: open
 * or uncertain. Nothing clears them, and they are never replayed or resumed.
 */
export function stuck<Step extends journal.JournalStep>(evidence: Evidence<Step>): Step[] {
  return journal.stuck(evidence?.steps ?? [])
}

/**
 * Steps that exited zero but were not verified yet. A fresh observation can
 * verify them, which is accounting and not replay.
 */
export function returned<Step extends journal.JournalStep>(evidence: Evidence<Step>): Step[] {
  return journal.returned(evidence?.steps ?? [])
}

/**
 * Stuck plus returned steps.
 */
export function unsettled<Step extends journal.JournalStep>(evidence: Evidence<Step>): Step[] {
  return journal.unsettled(evidence?.steps ?? [])
}

function unresolved(steps: readonly journal.JournalStep[], installation: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'INSTALLATION_UNRESOLVED',
    facts: [
      ['Installation', installation],
      ['Unresolved steps', steps.map(step => `${step.action} (${journal.stateOf(step)})`).join(', ')],
    ],
    retry,
  })
}

/**
 * An open or uncertain step blocks configuration and startup, because its
 * effect on the target is unknown and nothing here replays or resumes it.
 */
export function requireNotStuck(evidence: Evidence, installation: string, retry: string): void {
  const blocking = stuck(evidence)
  if (blocking.length > 0) {
    throw unresolved(blocking, installation, retry)
  }
}

/**
 * Any unsettled step blocks reassignment, because a returned step has not yet
 * been verified by a fresh observation.
 */
export function requireSettled(evidence: Evidence, installation: string, retry: string): void {
  const open = unsettled(evidence)
  if (open.length > 0) {
    throw unresolved(open, installation, retry)
  }
}
