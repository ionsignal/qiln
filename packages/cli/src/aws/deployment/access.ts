import { InstallerError } from '../../diagnostic/error'
import { AWS_SPEC } from '../spec'
import { deploymentFacts } from './facts'
import { sshReady } from './topology'
import type { SshOptions } from '../../transport/ssh/options'
import type { HostKey } from './hostkey'
import type { Deployment } from './types'

/**
 * Refuses unless the recorded deployment may be connected to: creation fully
 * verified, no removal started, and the administrative key bound.
 */
export function requireReady(record: Deployment): void {
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
 * The pinned endpoint of a recorded deployment, built from retained evidence
 * alone. The private key is deliberately absent: it is read only when a
 * connection is made.
 */
export function optionsOf(record: Deployment, pin: HostKey): SshOptions {
  return {
    host: pin.address,
    port: record.approval.ingress[0].port,
    username: record.approval.host.plan.bootstrap.user,
    fingerprint: pin.fingerprint,
    ...AWS_SPEC.deployment.ssh,
  }
}
