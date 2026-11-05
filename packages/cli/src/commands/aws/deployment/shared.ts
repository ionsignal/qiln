import { authenticate, requireAvailable } from '../shared'
import { Session } from '../../../aws/auth/session'
import { requireBound } from '../../../aws/deployment/binding'
import { Deployer } from '../../../aws/deployment/deployer'
import * as connections from '../../../aws/connections'
import * as deployments from '../../../aws/deployment/records'
import type { Dir } from '../../../state/files'
import type { ProgressSink } from '../../../aws/deployment/observe/progress'
import type { Deployment } from '../../../aws/deployment/types'
import type { DeploymentSelector } from '../../../aws/deployment/volume/alias'

export interface Target {
  record: Deployment
  directory: Dir
  region: string
}

export async function bindTarget(store: Dir, record: Deployment): Promise<Target> {
  const directory = await connections.open(store, record.connection)
  await requireAvailable(directory)
  const connection = requireBound(await connections.read(directory, record.connection), record)
  return {
    record,
    directory,
    region: connection.region,
  }
}

export async function openTarget(root: Dir, store: Dir, selector: DeploymentSelector): Promise<Target> {
  return await bindTarget(store, await deployments.select(root, selector))
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
