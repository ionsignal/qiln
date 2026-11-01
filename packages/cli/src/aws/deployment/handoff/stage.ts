import { InstallerError } from '../../../diagnostic/error'
import { stateOf } from '../ledger/step'
import type { Deployment, Step, Successor } from '../types'

/**
 * Where one retained-volume hand-off stands, judged from the predecessor that
 * reserved the volume and the replacement that reuses it. This is the one table
 * of hand-off meaning, so no other module compares these fields on its own.
 *
 * - none: nothing was reserved.
 * - reserved: the replacement names the predecessor and does not hold the
 *   volume yet. Reported only; the volume stays retained by the predecessor.
 * - attaching: the replacement's attach step is open or uncertain. The step
 *   ledger of the replacement already blocks it, so this is reported, and the
 *   chain stays valid.
 * - unfinalized: the replacement holds the volume (attach verified, or the
 *   reservation abandoned), but the predecessor has not recorded completion.
 *   Broken until `handoff` writes the missing record.
 * - unmatched: the reservation and the replacement do not name each other.
 *   Broken until `handoff` writes the missing record.
 * - completed: the predecessor recorded the hand-off as complete.
 */
export type Stage = 'none' | 'reserved' | 'attaching' | 'unfinalized' | 'unmatched' | 'completed'

type HandedOff = Deployment & { successor: Successor & { completedAt: string } }

/**
 * Only a completed successor link means the volume was handed off.
 */
export function handedOff(record: Deployment): record is HandedOff {
  return record.successor !== null && record.successor.completedAt !== null
}

/**
 * A later deployment reserved or took the volume, so it is not offered again.
 */
export function claimed(record: Deployment): boolean {
  return record.successor !== null
}

export function abandoned(record: Deployment): boolean {
  return record.abandonment !== null
}

export function attachOf(record: Deployment): Step | undefined {
  return record.steps.findLast(step => step.action === 'attach-volume')
}

/**
 * Whether the record answers for its data volume. A record that created the
 * volume always does. A reuse replacement does only once its attach is
 * verified or it released its reservation by abandonment, so a reservation
 * alone never makes it a holder.
 */
export function holdsVolume(record: Deployment): boolean {
  if (record.approval.host.volume.kind === 'new') {
    return true
  }
  const attach = attachOf(record)
  return abandoned(record) || (attach !== undefined && stateOf(attach) === 'verified')
}

/**
 * `replacement` is the record that `previous.successor` names, or a reuse
 * record that names `previous` as its predecessor. Null means none is recorded.
 */
export function stageOf(previous: Deployment, replacement: Deployment | null): Stage {
  const { successor } = previous
  if (successor === null && replacement === null) {
    return 'none'
  }
  if (
    successor === null ||
    replacement === null ||
    successor.to !== replacement.id ||
    replacement.previous !== previous.id
  ) {
    return 'unmatched'
  }
  if (successor.completedAt !== null) {
    return 'completed'
  }
  if (holdsVolume(replacement)) {
    return 'unfinalized'
  }
  const attach = attachOf(replacement)
  return attach !== undefined && ['open', 'uncertain'].includes(stateOf(attach)) ? 'attaching' : 'reserved'
}

/**
 * Evidence that contradicts itself: the chain cannot be trusted, and no new
 * reuse is offered, until the missing record is written.
 */
export function isBroken(stage: Stage): boolean {
  return stage === 'unmatched' || stage === 'unfinalized'
}

/**
 * The shared refusal for chain integrity, reuse offers, and every caller that
 * needs a settled predecessor.
 */
export function requireIntact(previous: Deployment, replacement: Deployment | null): void {
  const stage = stageOf(previous, replacement)
  if (!isBroken(stage)) {
    return
  }
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_HANDOFF_PENDING',
    facts: [
      ['Previous deployment', previous.id],
      ['Replacement deployment', replacement?.id ?? previous.successor?.to ?? 'none recorded'],
      [
        'Observed',
        stage === 'unmatched'
          ? 'The reservation and the replacement do not name each other.'
          : 'The replacement holds the volume, but the previous deployment has not recorded the completed hand-off.',
      ],
    ],
    retry:
      replacement === null
        ? `qiln aws deployment status --id ${previous.id}`
        : `qiln aws deployment handoff --id ${replacement.id}`,
  })
}

/**
 * The completion is missing although the replacement already holds the volume.
 */
export function needsCompletion(successor: Successor, replacement: Deployment): boolean {
  return successor.to === replacement.id && successor.completedAt === null && holdsVolume(replacement)
}

export function reserve(previous: Deployment, to: string): Deployment {
  return { ...previous, successor: { to, reservedAt: new Date().toISOString(), completedAt: null } }
}

export function complete(previous: Deployment, successor: Successor): Deployment {
  return { ...previous, successor: { ...successor, completedAt: new Date().toISOString() } }
}
