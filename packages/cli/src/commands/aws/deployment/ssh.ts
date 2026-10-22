import { InstallerError } from '../../../diagnostic/error'

/**
 * Reserved for an interactive administrative session, which is not ready. It
 * must refuse before any protected state, lock, key, AWS call, or connection.
 */
export function ssh(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_SSH_UNAVAILABLE',
  })
}
