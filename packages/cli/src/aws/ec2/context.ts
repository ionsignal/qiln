import { basename, dirname } from 'node:path'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { AWS_SPEC } from '../spec'
import { userId } from '../host'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, openDir, type Dir } from '../../state/files'
import { configuration, credentials } from '../auth/credentials'
import { requireIdentity, verifyIdentity } from '../auth/identity'
import { requireBound } from '../deployment/binding'
import { expectation } from '../deployment/expect'
import { stateOf } from '../deployment/step'
import { healthDue, unnamed } from '../deployment/topology'
import { requireOperationLock } from '../root'
import * as connections from '../connection/records'
import * as deployments from '../deployment/records'
import type { AwsIdentity } from '../types'
import type { DeploymentRequest } from './protocol'
import type { Deployment } from '../deployment/types'

export type Credentials = Awaited<ReturnType<typeof credentials>>

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

/**
 * The child derives its location from its own HOME, `<root>/connections/<name>/auth`,
 * and trusts nothing until the parent-held lock and the reloaded evidence agree.
 */
async function locate(): Promise<{ root: Dir; name: string; directory: Dir }> {
  const home = process.env.HOME
  if (!home || basename(home) !== AWS_SPEC.state.auth) {
    return notAttempted()
  }
  const connectionPath = dirname(home)
  const storePath = dirname(connectionPath)
  if (basename(storePath) !== AWS_SPEC.state.connections) {
    return notAttempted()
  }
  const ownership = {
    owner: userId(),
    mode: 0o700,
  }
  const root = await openDir(dirname(storePath), ownership)
  await requireOperationLock(root, process.ppid)
  const store = await openChildDir(root, AWS_SPEC.state.connections, ownership)
  const name = basename(connectionPath)
  const directory = await connections.open(store, name)
  if ((await connections.pending(directory)) !== null) {
    return notAttempted()
  }
  return { root, name, directory }
}

async function authenticate(loginRegion: string, expected: AwsIdentity, signal: AbortSignal): Promise<Credentials> {
  const resolved = await credentials(loginRegion)
  const sts = new STSClient({
    ...configuration(loginRegion),
    credentials: resolved,
  })
  const response = await sts
    .send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(AWS_SPEC.requestTimeoutMs)]),
    })
    .finally(() => sts.destroy())
  try {
    requireIdentity(
      verifyIdentity({
        accountId: response.Account,
        arn: response.Arn,
        userId: response.UserId,
      }),
      expected,
    )
  } catch {
    return notAttempted()
  }
  return resolved
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
      // Only a creation whose identity was never retained can leave a resource to look for.
      if (unnamed(record).length === 0) {
        return notAttempted()
      }
      return
    case 'health':
      // Health is read only for a fully created deployment that has no health evidence yet.
      if (!healthDue(record)) {
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
  const { name, directory } = await locate()
  const connection = await connections.read(directory, name)
  if (!connection?.managed) {
    return notAttempted()
  }
  return {
    region: connection.managed.deploymentRegion,
    credentials: await authenticate(connection.region, connection.identity, signal),
  }
}

export async function authorizeDeployment(request: DeploymentRequest, signal: AbortSignal): Promise<DeploymentAuthority> {
  const { root, name, directory } = await locate()
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
    credentials: await authenticate(connection.region, record.binding.operator, signal),
  }
}
