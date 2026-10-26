import { InstallerError } from '../diagnostic/error'
import { deploymentFacts } from './deployment/facts'
import { deploymentRecovery } from './recovery'
import { withAwsOperation, type AwsState } from './root'
import * as deployments from './deployment/records'
import type { Dir } from '../state/files'

/**
 * Unconfirmed child termination is sticky. Refusing before any authentication
 * keeps further child work from starting, and the error's unconfirmed
 * termination makes the outer operation retain its lock. Nothing here clears
 * the recorded termination.
 */
export async function requireConfirmedTermination(root: Dir): Promise<void> {
  const active = (await deployments.list(root)).find(record => record.termination === 'unconfirmed')
  if (active === undefined) {
    return
  }
  throw deploymentRecovery(
    new InstallerError({
      code: 'AWS_DEPLOYMENT_RECOVERY_REQUIRED',
    }),
    {
      termination: false,
      persistence: true,
    },
    deploymentFacts(active),
    `qiln aws deployment status --id ${active.id}`,
  )
}

/**
 * The AWS-operation lock plus the sticky-termination check. Commands and
 * handoffs that authenticate, start children, or connect use this instead of
 * `withAwsOperation`.
 */
export async function withConfirmedOperation<T>(create: boolean, run: (state: AwsState) => Promise<T>): Promise<T> {
  return await withAwsOperation(create, async state => {
    await requireConfirmedTermination(state.root)
    return await run(state)
  })
}
