import { InstallerError } from '../../diagnostic/error'
import { originOf } from '../deployment/lineage/chain'
import { prepareRetry } from '../deployment/retry'
import { sshReady } from '../deployment/topology'
import type { Deployment } from '../deployment/types'
import type { Dir } from '../../state/files'

/**
 * What the registration service needs to know about an installation, taken
 * from retained deployment evidence alone. `principal` is the operator that the
 * service allocates for, in the service's own `account:userId` form, and
 * `address` is the recorded Elastic IP, which is point-in-time evidence and not
 * a fresh observation.
 */
export interface Subject {
  installation: string
  principal: string
  address: string
}

/**
 * Derived from the immutable ID of the deployment that created the retained
 * data volume, never from an alias or operator input, and within the
 * installation name rule. Every later deployment of the same volume chain keeps
 * the name, so a host replacement keeps the installation directory.
 */
export function installationName(originId: string): string {
  return `aws-${originId}`
}

export async function subjectOf(root: Dir, record: Deployment): Promise<Subject> {
  const { hostKey, binding } = record
  if (hostKey === null || !sshReady(record)) {
    throw new InstallerError({
      code: 'AWS_INSTALLATION_BINDING_REFUSED',
      facts: [
        ['Deployment', record.id],
        ['Reason', 'Creation is not complete, or no host-key pin is retained.'],
      ],
      retry: prepareRetry(record.id),
    })
  }
  return {
    installation: installationName(await originOf(root, record)),
    principal: `${binding.operator.accountId}:${binding.operator.userId}`,
    address: hostKey.address,
  }
}
