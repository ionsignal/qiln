import { catalog } from '../../../diagnostic/catalog'
import { isCancellation } from '../../../aws/errors'
import { terminationConfirmed } from '../../../aws/recovery'
import { releaseReservation } from './abandon'
import { progressSink } from './progress'
import { removeOnApproval } from './remove'
import { authenticateDeployer, bindTarget } from './shared'
import { abandonable, failureDisclosure, refusalOf, removable } from '../../../aws/deployment/observe/facts'
import * as deployments from '../../../aws/deployment/records'
import type { Deployment } from '../../../aws/deployment/types'
import type { Dir } from '../../../state/files'
import type { Prompts } from '../../../terminal/prompts'
import type { Reporter } from '../../../terminal/reporter'

/**
 * Offers to clean up after a creation that AWS definitively refused: first the
 * removal of what it already created, then, for a reused data volume whose
 * attach never returned, the release of its reservation. Each step has its own
 * default-no approval, and declining one stops the offer, so nothing changed
 * beyond what was approved. A record without such a refusal is left alone. It
 * runs under the operation lock held by the calling command.
 */
export async function removeRefused(
  root: Dir,
  store: Dir,
  record: Deployment,
  prompts: Prompts,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<void> {
  const failure = refusalOf(record)
  if (failure === null) {
    return
  }
  reporter.section('Creation refused')
  reporter.facts([
    ['Deployment', record.id],
    ['Last failure', failureDisclosure(record)],
  ])
  reporter.info(catalog[failure.code].explanation)
  const target = await bindTarget(store, record)
  const deployer = await authenticateDeployer(root, target, signal, progressSink(reporter))
  if (removable(deployer.record)) {
    const observation = await deployer.observe(signal)
    if (!(await removeOnApproval(root, deployer, observation, prompts, reporter, signal))) {
      return
    }
  }
  if (abandonable(deployer.record)) {
    await releaseReservation(root, deployer, prompts, reporter, signal)
  }
}

/**
 * Cleanup after a failed creation must not mask that failure. A cancellation, or
 * a failure that left child termination unconfirmed, still propagates, because
 * the operation lock must then be retained. Any other cleanup failure is
 * reported, and the caller rethrows its original.
 */
export async function tryRemoveRefused(
  root: Dir,
  store: Dir,
  deploymentId: string,
  prompts: Prompts,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<void> {
  try {
    const record = await deployments.select(root, { kind: 'id', value: deploymentId })
    await removeRefused(root, store, record, prompts, reporter, signal)
  } catch (error: unknown) {
    if (!terminationConfirmed(error) || isCancellation(error)) {
      throw error
    }
    reporter.failure(error)
  }
}
