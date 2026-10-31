import { InstallerError } from '../../../diagnostic/error'

/**
 * Leaf module: the deployment record modules import each other, so this one
 * imports none of them.
 */
export function invalidDeployment(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_STATE_INVALID',
  })
}
