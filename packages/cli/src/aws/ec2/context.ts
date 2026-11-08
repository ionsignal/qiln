import { InstallerError } from '../../diagnostic/error'
import { requireBound } from '../deployment/binding'
import { expectation } from '../deployment/observe/expect'
import { stateOf } from '../deployment/ledger/step'
import { healthDue, hostKeyDue, unnamed } from '../deployment/topology'
import { authenticate, locate, type Credentials } from '../child/context'
import * as connections from '../connections'
import * as deployments from '../deployment/records'
import type { Dir } from '../../state/files'
import type { DeploymentRequest } from './protocol'
import type { Deployment } from '../deployment/types'

export interface Authority {
  region: string
  credentials: Credentials
}

export interface DeploymentAuthority extends Authority {
  root: Dir
  record: Deployment
}

export function notAttempted(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_NOT_ATTEMPTED',
  })
}

function requireAuthority(record: Deployment, request: DeploymentRequest): void {
  if (record.id !== request.deploymentId || record.termination !== 'unconfirmed') {
    return notAttempted()
  }
  switch (request.kind) {
    case 'mutate': {
      const step = record.steps.at(-1)
      if (step === undefined || step.id !== request.operationId || stateOf(step) !== 'open') {
        return notAttempted()
      }
      return
    }
    case 'observe':
      if (expectation(record).length === 0) {
        return notAttempted()
      }
      return
    case 'candidates':
      if (unnamed(record).length === 0) {
        return notAttempted()
      }
      return
    case 'health':
      if (!healthDue(record)) {
        return notAttempted()
      }
      return
    case 'hostkey':
      if (!hostKeyDue(record)) {
        return notAttempted()
      }
      return
  }
}

/**
 * Connection-level authority for read-only preparation, which runs before any
 * deployment exists. It targets the recorded deployment region, not the
 * editable login region that only supplies credentials.
 */
export async function authorizePreparation(signal: AbortSignal): Promise<Authority> {
  const { name, directory } = await locate(notAttempted)
  const connection = await connections.read(directory, name)
  if (!connection?.managed) {
    return notAttempted()
  }
  return {
    region: connection.managed.deploymentRegion,
    credentials: await authenticate(connection.region, connection.identity, signal, notAttempted),
  }
}

export async function authorizeDeployment(request: DeploymentRequest, signal: AbortSignal): Promise<DeploymentAuthority> {
  const { root, name, directory } = await locate(notAttempted)
  const record = await deployments.read(root, request.deploymentId)
  if (!record || record.connection !== name) {
    return notAttempted()
  }
  const connection = requireBound(await connections.read(directory, name), record)
  requireAuthority(record, request)
  return {
    root,
    record,
    region: record.binding.region,
    credentials: await authenticate(connection.region, record.binding.operator, signal, notAttempted),
  }
}
