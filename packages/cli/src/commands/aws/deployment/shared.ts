import { InstallerError } from '../../../diagnostic/error'
import * as connections from '../../../aws/connection/records'
import { Session } from '../../../aws/auth/session'
import type { DeploymentSelector } from '../../../aws/deployment/alias'
import { requireBound } from '../../../aws/deployment/binding'
import { Deployer } from '../../../aws/deployment/deployer'
import * as deployments from '../../../aws/deployment/records'
import type { Deployment } from '../../../aws/deployment/types'
import type { Dir } from '../../../state/files'
import { authenticate, requireAvailable } from '../shared'

export interface Target {
  record: Deployment
  directory: Dir
  region: string
}

export function notFound(selector: DeploymentSelector): InstallerError {
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_NOT_FOUND',
    facts: [[selector.kind === 'id' ? 'Deployment ID' : 'Deployment alias', selector.value]],
    retry: 'qiln aws deployment list',
  })
}

/**
 * The connection is resolved from the record, never from an argument, and must
 * match its immutable bindings rather than just its name.
 */
export async function openTarget(root: Dir, store: Dir, selector: DeploymentSelector): Promise<Target> {
  const record = await deployments.find(root, selector)
  if (!record) {
    throw notFound(selector)
  }
  const directory = await connections.open(store, record.connection)
  await requireAvailable(directory)
  const connection = requireBound(await connections.read(directory, record.connection), record)
  return {
    record,
    directory,
    region: connection.region,
  }
}

export async function authenticateDeployer(root: Dir, target: Target, signal: AbortSignal): Promise<Deployer> {
  const session = await Session.open(target.directory, target.region)
  await authenticate(session, target.record.binding.operator, signal)
  return Deployer.open(root, session, target.record)
}
