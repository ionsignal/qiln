import { basename, dirname } from 'node:path'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { AWS_SPEC } from '../spec'
import { userId } from '../host'
import { openChildDir, openDir, type Dir } from '../../state/files'
import { configuration, credentials } from '../auth/credentials'
import { requireIdentity, verifyIdentity } from '../auth/identity'
import { requireOperationLock } from '../root'
import * as connections from '../connections'
import type { AwsIdentity } from '../types'

/**
 * The child's own definite "nothing was attempted" failure, raised when the
 * retained evidence or the authenticated identity does not agree.
 */
export type Refusal = () => never
export type Credentials = Awaited<ReturnType<typeof credentials>>


/**
 * The child derives its location from its own HOME, `<root>/connections/<name>/auth`,
 * and trusts nothing until the parent-held lock and the reloaded evidence agree.
 */
export async function locate(refuse: Refusal): Promise<{ root: Dir; name: string; directory: Dir }> {
  const home = process.env.HOME
  if (!home || basename(home) !== AWS_SPEC.state.auth) {
    return refuse()
  }
  const connectionPath = dirname(home)
  const storePath = dirname(connectionPath)
  if (basename(storePath) !== AWS_SPEC.state.connections) {
    return refuse()
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
    return refuse()
  }
  return { root, name, directory }
}

export async function authenticate(
  loginRegion: string,
  expected: AwsIdentity,
  signal: AbortSignal,
  refuse: Refusal,
): Promise<Credentials> {
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
    return refuse()
  }
  return resolved
}
