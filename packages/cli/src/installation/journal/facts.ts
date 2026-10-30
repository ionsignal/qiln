import * as journal from '../../journal/step'
import { InstallerError } from '../../diagnostic/error'
import type { ConfigureEvidence, ConfigureStep } from './types'

/**
 * Steps whose effect is unknown and which only an operator can resolve: open
 * or uncertain. Nothing clears them, and they are never replayed or resumed.
 */
export function stuck(evidence: ConfigureEvidence | null): ConfigureStep[] {
  return journal.stuck(evidence?.steps ?? [])
}

/**
 * Steps that exited zero but were not verified yet. A fresh observation can
 * verify them, which is accounting and not replay.
 */
export function returned(evidence: ConfigureEvidence | null): ConfigureStep[] {
  return journal.returned(evidence?.steps ?? [])
}

/**
 * Stuck plus returned steps.
 */
export function unsettled(evidence: ConfigureEvidence | null): ConfigureStep[] {
  return journal.unsettled(evidence?.steps ?? [])
}

function unresolved(steps: readonly ConfigureStep[], installation: string, retry: string): InstallerError {
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
 * An open or uncertain step blocks configuration, because its effect on the
 * Incus daemon is unknown and nothing here replays or resumes it.
 */
export function requireNotStuck(evidence: ConfigureEvidence | null, installation: string, retry: string): void {
  const blocking = stuck(evidence)
  if (blocking.length > 0) {
    throw unresolved(blocking, installation, retry)
  }
}

/**
 * Any unsettled step blocks reassignment, because a returned step has not yet
 * been verified by a fresh observation.
 */
export function requireSettled(evidence: ConfigureEvidence | null, installation: string, retry: string): void {
  const open = unsettled(evidence)
  if (open.length > 0) {
    throw unresolved(open, installation, retry)
  }
}
