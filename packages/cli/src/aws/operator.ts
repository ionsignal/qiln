import { InstallerError } from '../diagnostic/error'
import { validName } from './types'

export const OPERATOR_PATH = '/qiln/operators/'

export function operatorName(connection: string): string {
  if (!validName(connection)) {
    throw new InstallerError({
      code: 'AWS_CONNECTION_NAME_INVALID',
    })
  }
  return `qiln-${connection}`
}

export function operatorArn(accountId: string, connection: string): string {
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw new InstallerError({
      code: 'AWS_IDENTITY_INVALID',
    })
  }
  return `arn:aws:iam::${accountId}:user${OPERATOR_PATH}${operatorName(connection)}`
}

export function operatorTags(accountId: string, connection: string, operationId: string) {
  return [
    { Key: 'qiln:managed-by', Value: 'qiln-cli' },
    { Key: 'qiln:account', Value: accountId },
    { Key: 'qiln:connection', Value: connection },
    { Key: 'qiln:bootstrap', Value: operationId },
  ]
}
