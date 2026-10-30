import { InstallerError } from '../../diagnostic/error'
import { accept } from '../primitives'
import { authenticationSchema, identitySchema, type AwsAuthentication, type AwsIdentity } from '../types'

export function verifyIdentity(value: { accountId: unknown; arn: unknown; userId: unknown }): AwsIdentity {
  if (
    typeof value.accountId !== 'string' ||
    !/^[0-9]{12}$/.test(value.accountId) ||
    typeof value.arn !== 'string' ||
    typeof value.userId !== 'string'
  ) {
    throw new InstallerError({
      code: 'AWS_IDENTITY_INVALID',
    })
  }
  if (value.arn === `arn:aws:iam::${value.accountId}:root`) {
    throw new InstallerError({
      code: 'AWS_ROOT_REFUSED',
    })
  }
  if (!value.arn.startsWith(`arn:aws:iam::${value.accountId}:user/`)) {
    throw new InstallerError({
      code: 'AWS_PRINCIPAL_UNSUPPORTED',
    })
  }
  const identity = accept(identitySchema, value)
  if (identity === null) {
    throw new InstallerError({
      code: 'AWS_IDENTITY_INVALID',
    })
  }
  return identity
}

export function sameIdentity(left: AwsIdentity, right: AwsIdentity): boolean {
  return left.accountId === right.accountId && left.arn === right.arn && left.userId === right.userId
}

export function requireIdentity(actual: AwsIdentity, expected: AwsIdentity): void {
  if (!sameIdentity(actual, expected)) {
    throw new InstallerError({
      code: 'AWS_IDENTITY_MISMATCH',
      facts: [
        ['Expected account', expected.accountId],
        ['Expected operator', expected.arn],
        ['Expected user ID', expected.userId],
        ['Authenticated account', actual.accountId],
        ['Authenticated operator', actual.arn],
        ['Authenticated user ID', actual.userId],
      ],
      retry: 'qiln aws connect',
    })
  }
}

export function requireAuthentication(authentication: AwsAuthentication, expected: AwsIdentity): void {
  if (!authenticationSchema.safeParse(authentication).success) {
    throw new InstallerError({
      code: 'AWS_IDENTITY_INVALID',
    })
  }
  if (new Date(authentication.expiresAt).getTime() <= Date.now()) {
    throw new InstallerError({
      code: 'AWS_AUTH_EXPIRED',
    })
  }
  requireIdentity(authentication.identity, expected)
}
