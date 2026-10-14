import { InstallerError } from '../../diagnostic/error'
import { sameIdentity } from '../auth/identity'
import type { AwsConnection } from '../types'
import type { Deployment } from './types'

/**
 * Matches immutable identities, creation identity and policy identity. A
 * connection name alone never establishes that a deployment belongs to it.
 * Deployments bind only the foundation policy, which grants their authority.
 */
export function requireBound(connection: AwsConnection | null, record: Deployment): AwsConnection {
  const managed = connection?.managed
  if (
    !connection ||
    !managed ||
    connection.name !== record.connection ||
    !sameIdentity(connection.identity, record.binding.operator) ||
    managed.creationId !== record.binding.creationId ||
    managed.permissionRegion !== record.binding.region ||
    managed.policies.foundation.arn !== record.binding.foundation.arn ||
    managed.policies.foundation.id !== record.binding.foundation.id
  ) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_STATE_INVALID',
    })
  }
  return connection
}
