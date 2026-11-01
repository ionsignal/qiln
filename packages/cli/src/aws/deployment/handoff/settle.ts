import { InstallerError } from '../../../diagnostic/error'
import { invalidDeployment } from '../ledger/invalid'
import { complete, needsCompletion, reserve } from './stage'
import * as deployments from '../records'
import type { Dir } from '../../../state/files'
import type { Deployment, Observation } from '../types'

async function predecessorOf(root: Dir, replacement: Deployment): Promise<Deployment> {
  const { volume } = replacement.approval.host
  const previous = volume.kind === 'reuse' ? await deployments.read(root, volume.from) : null
  return previous ?? invalidDeployment()
}

/**
 * Brings the predecessor's successor link up to what the replacement's durable
 * evidence supports: the missing reservation, then the missing completion once
 * the replacement holds the volume. It is idempotent, reads local evidence
 * only, never calls AWS, and never replays an attachment.
 */
export async function settle(root: Dir, replacement: Deployment): Promise<void> {
  let previous = await predecessorOf(root, replacement)
  if (previous.successor === null) {
    previous = reserve(previous, replacement.id)
    await deployments.save(root, previous)
  }
  const { successor } = previous
  if (successor !== null && needsCompletion(successor, replacement)) {
    await deployments.save(root, complete(previous, successor))
  }
}

/**
 * Settles right after the write that made the replacement hold the volume. A
 * failure leaves the hand-off pending for the explicit `handoff` command, which
 * writes the missing record from local evidence, so both writers share one
 * recovery pointer. `observed` says which write preceded the failure.
 */
export async function settleOrPending(root: Dir, replacement: Deployment, observed: string): Promise<void> {
  try {
    await settle(root, replacement)
  } catch {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_HANDOFF_PENDING',
      facts: [
        ['Replacement deployment', replacement.id],
        ['Observed', observed],
      ],
      retry: `qiln aws deployment handoff --id ${replacement.id}`,
    })
  }
}

/**
 * Releases the reservation of a replacement whose volume was observed available
 * and unattached. The replacement is written first and settles the predecessor
 * afterwards, so an interruption leaves an unfinalized hand-off that `settle`
 * completes, never a completed one without evidence. `replacement` is the
 * record that already retains `observation` as its latest, and the transition
 * judges the remaining preconditions.
 */
export async function abandon(root: Dir, replacement: Deployment, observation: Observation): Promise<void> {
  const released: Deployment = {
    ...replacement,
    abandonment: { approvedAt: new Date().toISOString(), observation },
  }
  await deployments.save(root, released)
  await settleOrPending(
    root,
    released,
    'The reservation was released, but the previous deployment could not record the completed hand-off.',
  )
}
