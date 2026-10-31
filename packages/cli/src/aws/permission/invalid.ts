import { InstallerError } from '../../diagnostic/error'

/**
 * Leaf module shared by the permission and IAM record modules, so neither
 * imports the other for it.
 */
export function invalidPermission(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}
