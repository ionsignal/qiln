import { InstallerError } from '../../../diagnostic/error'
import { AWS_SPEC } from '../../../aws/spec'
import { deploymentFacts } from '../../../aws/deployment/facts'
import { sshReady } from '../../../aws/deployment/topology'
import { readPrivateKey } from '../../../aws/ssh/private'
import { withSsh, type Remote } from '../../../ssh/connections'
import { SshError } from '../../../ssh/failure'
import { progressSink } from './progress'
import { authenticateDeployer, type Target } from './shared'
import type { Dir } from '../../../state/files'
import type { HostKey } from '../../../aws/deployment/hostkey'
import type { Deployment } from '../../../aws/deployment/types'
import type { SshOptions } from '../../../ssh/options'
import type { Reporter } from '../../../terminal/reporter'

/**
 * Everything needed to connect to a recorded deployment, resolved without
 * opening a connection. `record` is current as of resolution, including a
 * host-key pin that resolution retained, unlike the snapshot in `Target`. The
 * private key is deliberately absent: it is read only when a connection is made.
 */
export interface Access {
  record: Deployment
  options: SshOptions
  retry: string
}

interface Pinned {
  record: Deployment
  pin: HostKey
}

function requireReady(record: Deployment): void {
  if (sshReady(record)) {
    return
  }
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_ACCESS_REFUSED',
    facts: [
      ...deploymentFacts(record),
      ['Observed', 'Creation is not fully verified, removal has begun, or no administrative key is bound.'],
    ],
    retry: `qiln aws deployment status --id ${record.id}`,
  })
}

/**
 * A retained pin is used as is, with no AWS call and no AWS credentials.
 * Otherwise the pin is resolved and retained before any connection is made,
 * and the record returned is the one that holds it.
 */
async function ensurePin(root: Dir, target: Target, reporter: Reporter, signal: AbortSignal): Promise<Pinned> {
  if (target.record.hostKey !== null) {
    reporter.row('reused', 'SSH host key', 'retained pin used; no AWS call was made')
    return { record: target.record, pin: target.record.hostKey }
  }
  const deployer = await authenticateDeployer(root, target, signal, progressSink(reporter))
  const pin = await deployer.hostKey(signal)
  return { record: deployer.record, pin }
}

/**
 * Refuses unless the recorded deployment may be connected to, then resolves
 * the pinned endpoint. This may authenticate, call AWS, and retain the pin in
 * the deployment record. The returned `record` includes it. `retry` is the
 * command the caller wants shown when the connection cannot be established.
 */
export async function resolveAccess(
  root: Dir,
  target: Target,
  retry: string,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<Access> {
  requireReady(target.record)
  const { record, pin } = await ensurePin(root, target, reporter, signal)
  return {
    record,
    retry,
    options: {
      host: pin.address,
      port: record.approval.ingress[0].port,
      username: record.approval.host.plan.bootstrap.user,
      fingerprint: pin.fingerprint,
      ...AWS_SPEC.deployment.ssh,
    },
  }
}

/**
 * Loads the protected administrative key, connects with the pinned host key,
 * and always zeroes the key afterwards. The administrator-network hint applies
 * only to a failure to establish the connection, never to one that ended while
 * `use` was running.
 */
export async function withRemote<T>(
  root: Dir,
  access: Access,
  signal: AbortSignal,
  use: (remote: Remote) => Promise<T>,
): Promise<T> {
  const privateKey = await readPrivateKey(root, access.record)
  try {
    let started = false
    try {
      return await withSsh(access.options, privateKey, signal, remote => {
        started = true
        return use(remote)
      })
    } catch (error: unknown) {
      if (!started && error instanceof SshError && error.kind === 'connection') {
        throw new InstallerError({
          code: error.code,
          facts: [...error.facts, ['Administrator network', access.record.approval.ingress[0].cidr]],
          retry: access.retry,
        })
      }
      throw error
    }
  } finally {
    privateKey.fill(0)
  }
}
