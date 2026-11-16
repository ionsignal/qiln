import { InstallerError } from '../../diagnostic/error'
import { sameIdentity } from '../auth/identity'
import type { AwsConnection, ConnectionAuthority } from '../types'
import type { Deployment, DeploymentBinding } from './types'

function sameAuthority(authority: ConnectionAuthority, binding: DeploymentBinding): boolean {
  const recorded = binding.authority
  if (authority.deploymentRegion !== binding.region) {
    return false
  }
  if (authority.kind === 'existing') {
    return recorded.kind === 'existing'
  }
  return (
    recorded.kind === 'created' &&
    authority.creationId === recorded.creationId &&
    authority.policies.foundation.arn === recorded.foundation.arn &&
    authority.policies.foundation.id === recorded.foundation.id
  )
}

/**
 * Matches the immutable operator identity, the deployment region, and the
 * authority identity: the creation and foundation policy of a created operator.
 * A connection name alone never establishes that a deployment belongs to it, and
 * re-verification metadata is excluded so it never unbinds a deployment.
 */
export function requireBound(connection: AwsConnection | null, record: Deployment): AwsConnection {
  if (
    !connection ||
    connection.name !== record.connection ||
    !sameIdentity(connection.identity, record.binding.operator) ||
    !sameAuthority(connection.authority, record.binding)
  ) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_STATE_INVALID',
    })
  }
  return connection
}
