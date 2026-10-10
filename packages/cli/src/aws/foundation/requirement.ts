import type { AwsConnection } from '../types'
import { specification, type PermissionSpec } from './policy'

export function currentRequirement(connection: AwsConnection): PermissionSpec | null {
  if (!connection.managed) {
    return null
  }
  return specification(connection.identity.accountId, connection.name, connection.managed.permissionRegion)
}

export function reviewRequired(connection: AwsConnection): boolean {
  const desired = currentRequirement(connection)
  const verified = connection.managed?.verified
  return (
    desired !== null &&
    (!verified || verified.version !== desired.version || verified.sha256 !== desired.sha256)
  )
}
