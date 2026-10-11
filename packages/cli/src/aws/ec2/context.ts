import { basename, dirname } from 'node:path'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, openDir } from '../../state/files'
import { configuration, credentials } from '../auth/credentials'
import { requireIdentity, verifyIdentity } from '../auth/identity'
import * as connections from '../connection/records'
import { requireBound } from '../deployment/binding'
import * as deployments from '../deployment/records'
import type { Deployment } from '../deployment/types'
import { userId } from '../host'
import { requireOperationLock } from '../root'
import { AWS_SPEC } from '../spec'
import type { Request } from './protocol'

type Credentials = Awaited<ReturnType<typeof credentials>>

export interface Authority {
  record: Deployment
  credentials: Credentials
}

/** Local validation fails before any mutating call, so the refusal is definite. */
export function notAttempted(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_NOT_ATTEMPTED',
  })
}

/** Diagnostics raised by local checks are refusals; provider errors keep their own classification. */
function refuseLocal(error: unknown): never {
  if (error instanceof InstallerError) {
    return notAttempted()
  }
  throw error
}

/**
 * The child derives its location from its own HOME, `<root>/connections/<name>/auth`,
 * and trusts nothing until the parent-held lock and the reloaded evidence agree.
 */
async function reload(request: Request) {
  const home = process.env.HOME
  if (!home || basename(home) !== AWS_SPEC.state.auth) {
    return notAttempted()
  }
  const connectionPath = dirname(home)
  const storePath = dirname(connectionPath)
  if (basename(storePath) !== AWS_SPEC.state.connections) {
    return notAttempted()
  }
  const root = await openDir(dirname(storePath), {
    owner: userId(),
    mode: 0o700,
  })
  await requireOperationLock(root, process.ppid)
  const record = await deployments.read(root, request.deploymentId)
  if (!record || record.connection !== basename(connectionPath)) {
    return notAttempted()
  }
  const store = await openChildDir(root, AWS_SPEC.state.connections, {
    owner: userId(),
    mode: 0o700,
  })
  const directory = await connections.open(store, record.connection)
  if ((await connections.pending(directory)) !== null) {
    return notAttempted()
  }
  const connection = requireBound(await connections.read(directory, record.connection), record)
  return {
    record,
    connection,
  }
}

function requireAuthority(record: Deployment, request: Request): void {
  if (record.id !== request.deploymentId || record.termination !== 'unconfirmed') {
    return notAttempted()
  }
  const creation = record.creation
  switch (request.kind) {
    case 'create':
      if (
        creation === null ||
        creation.id !== request.operationId ||
        creation.returned !== null ||
        creation.failure !== null
      ) {
        return notAttempted()
      }
      return
    case 'delete': {
      const removal = record.removals.at(-1)
      if (
        creation?.returned == null ||
        removal === undefined ||
        removal.id !== request.operationId ||
        removal.returned !== null ||
        removal.failure !== null
      ) {
        return notAttempted()
      }
      return
    }
    case 'observe':
      if (creation?.returned == null) {
        return notAttempted()
      }
      return
    case 'candidates':
      if (creation === null || creation.returned !== null) {
        return notAttempted()
      }
      return
  }
}

export async function authorize(request: Request, signal: AbortSignal): Promise<Authority> {
  const { record, connection } = await reload(request).catch(notAttempted)
  requireAuthority(record, request)
  // Credentials resolve with the connection's login region; EC2 targets the deployment's immutable region.
  const resolved = await credentials(connection.region).catch(refuseLocal)
  const sts = new STSClient({
    ...configuration(connection.region),
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
      record.binding.operator,
    )
  } catch {
    return notAttempted()
  }
  return {
    record,
    credentials: resolved,
  }
}
