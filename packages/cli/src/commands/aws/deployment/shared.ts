import { authenticate, requireAvailable } from '../shared'
import { Session } from '../../../aws/auth/session'
import { requireBound } from '../../../aws/deployment/binding'
import { Deployer } from '../../../aws/deployment/deployer'
import * as connections from '../../../aws/connection/records'
import * as deployments from '../../../aws/deployment/records'
import type { Dir } from '../../../state/files'
import type { ProgressSink } from '../../../aws/deployment/progress'
import type { Deployment } from '../../../aws/deployment/types'
import type { DeploymentSelector } from '../../../aws/deployment/alias'

/**
 * `record` is a snapshot from the moment the target was opened. An operation
 * that retains evidence, such as resolving a host-key pin, outdates it, so such
 * an operation must hand back its own current record.
 */
export interface Target {
  record: Deployment
  directory: Dir
  region: string
}

/**
 * The connection is resolved from the record, never from an argument, and must
 * match its immutable bindings rather than just its name.
 */
export async function openTarget(root: Dir, store: Dir, selector: DeploymentSelector): Promise<Target> {
  const record = await deployments.select(root, selector)
  const directory = await connections.open(store, record.connection)
  await requireAvailable(directory)
  const connection = requireBound(await connections.read(directory, record.connection), record)
  return {
    record,
    directory,
    region: connection.region,
  }
}

export async function authenticateDeployer(
  root: Dir,
  target: Target,
  signal: AbortSignal,
  progress?: ProgressSink,
): Promise<Deployer> {
  const session = await Session.open(target.directory, target.region)
  await authenticate(session, target.record.binding.operator, signal)
  return Deployer.open(root, session, target.record, progress)
}
