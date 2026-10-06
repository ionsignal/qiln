import { createHash } from 'node:crypto'
import { InstallerError } from '../../diagnostic/error'
import { isRecord, validName } from '../types'
import type { PolicyReview } from './types'

export const POLICY = Object.freeze({
  path: '/qiln/operators/',
  managedArn: 'arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess',
  inlineName: 'QilnOperatorSelfService',
})

const signInDocument = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Action: ['signin:AuthorizeOAuth2Access', 'signin:CreateOAuth2Token'],
      Resource: 'arn:aws:signin:*:*:oauth2/public-client/*',
    },
  ],
}

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_BOOTSTRAP_POLICY_CHANGED',
  })
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown) => canonical(entry)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return invalid()
}

/**
 * Some SDK responses already contain plain JSON. Decode only when direct
 * parsing fails, so literal percent characters are not decoded twice.
 */
export function document(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 65_536) {
    return invalid()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    try {
      parsed = JSON.parse(decodeURIComponent(value)) as unknown
    } catch {
      return invalid()
    }
  }
  return canonical(parsed)
}

export function review(versionId: string | undefined, value: string | undefined): PolicyReview {
  if (typeof versionId !== 'string' || !/^v[1-9][0-9]{0,9}$/.test(versionId)) {
    return invalid()
  }
  const normalized = document(value)
  if (normalized !== canonical(signInDocument)) {
    return invalid()
  }
  return {
    versionId,
    document: normalized,
    sha256: createHash('sha256').update(normalized).digest('hex'),
  }
}

export function isReview(value: unknown): value is PolicyReview {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'document,sha256,versionId' ||
    typeof value.versionId !== 'string' ||
    typeof value.document !== 'string' ||
    typeof value.sha256 !== 'string'
  ) {
    return false
  }
  try {
    const expected = review(value.versionId, value.document)
    return expected.document === value.document && expected.sha256 === value.sha256
  } catch {
    return false
  }
}

export function sameReview(left: PolicyReview, right: PolicyReview): boolean {
  return left.versionId === right.versionId && left.document === right.document && left.sha256 === right.sha256
}

export function name(connection: string): string {
  if (!validName(connection)) {
    throw new InstallerError({
      code: 'AWS_CONNECTION_NAME_INVALID',
    })
  }
  return `qiln-${connection}`
}

export function arn(accountId: string, connection: string): string {
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw new InstallerError({
      code: 'AWS_IDENTITY_INVALID',
    })
  }
  return `arn:aws:iam::${accountId}:user${POLICY.path}${name(connection)}`
}

export function tags(accountId: string, connection: string, operationId: string) {
  return [
    { Key: 'qiln:managed-by', Value: 'qiln-cli' },
    { Key: 'qiln:account', Value: accountId },
    { Key: 'qiln:connection', Value: connection },
    { Key: 'qiln:bootstrap', Value: operationId },
  ]
}

export function selfService(accountId: string, connection: string): string {
  const userArn = arn(accountId, connection)
  const operatorName = name(connection)
  return canonical({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReadEnrollmentInformation',
        Effect: 'Allow',
        Action: ['iam:GetAccountPasswordPolicy', 'iam:ListVirtualMFADevices'],
        Resource: '*',
      },
      {
        Sid: 'ManageOwnPasswordAndMFA',
        Effect: 'Allow',
        Action: [
          'iam:ChangePassword',
          'iam:GetUser',
          'iam:GetLoginProfile',
          'iam:EnableMFADevice',
          'iam:GetMFADevice',
          'iam:ListMFADevices',
          'iam:ResyncMFADevice',
        ],
        Resource: userArn,
      },
      {
        Sid: 'ManageOwnVirtualMFADevices',
        Effect: 'Allow',
        Action: ['iam:CreateVirtualMFADevice', 'iam:DeleteVirtualMFADevice'],
        Resource: [`arn:aws:iam::${accountId}:mfa/${operatorName}`, `arn:aws:iam::${accountId}:mfa/${operatorName}-*`],
      },
      {
        Sid: 'DeactivateOwnMFAWhenAuthenticatedWithMFA',
        Effect: 'Allow',
        Action: 'iam:DeactivateMFADevice',
        Resource: userArn,
        Condition: {
          Bool: {
            'aws:MultiFactorAuthPresent': 'true',
          },
        },
      },
    ],
  })
}
