import { basename, dirname } from 'node:path'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, openDir, type Dir } from '../../state/files'
import { configuration, credentials } from '../auth/credentials'
import { requireIdentity, verifyIdentity } from '../auth/identity'
import * as connections from '../connection/records'
import { requireBound } from '../deployment/binding'
import * as deployments from '../deployment/records'
import { stateOf } from '../deployment/step'
import { expectation } from '../deployment/topology'
import type { Deployment } from '../deployment/types'
import { userId } from '../host'
import { requireOperationLock } from '../root'
import { AWS_SPEC } from '../spec'
import type { AwsIdentity } from '../types'
import type { DeploymentRequest } from './protocol'

export type Credentials = Awaited<ReturnType<typeof credentials>>

export interface Authority {
  region: string
  credentials: Credentials
}

export interface DeploymentAuthority extends Authority {
  record: Deployment
}

/** Local validation fails before any mutating call, so the refusal is definite. */
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

/** Credentials resolve with the connection's login region; the caller picks the EC2 region. */
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
    case 'candidates': {
      const first = record.steps.at(0)
      if (first === undefined || first.action !== 'create-vpc' || first.returned !== null) {
        return notAttempted()
      }
      return
    }
  }
}

/** Placement has no deployment: the saved operator and its managed foundation are the authority. */
export async function authorizePlacement(signal: AbortSignal): Promise<Authority> {
  const { name, directory } = await locate()
  const connection = await connections.read(directory, name)
  const managed = connection?.managed
  if (!connection || !managed?.foundation || !managed.verified) {
    return notAttempted()
  }
  return {
    region: managed.permissionRegion,
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
    record,
    // EC2 targets the deployment's immutable region, not the editable login region.
    region: record.binding.region,
    credentials: await authenticate(connection.region, record.binding.operator, signal),
  }
}
