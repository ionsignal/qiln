import { createHash } from 'node:crypto'
import { InstallerError } from '../../diagnostic/error'
import { isRecord } from '../../guards'
import { canonical } from '../../json'
import { document } from '../permission/document'
import { operatorArn, operatorName } from '../operator'
import type { PolicyReview } from './types'

export const POLICY = Object.freeze({
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

export function selfService(accountId: string, connection: string): string {
  const userArn = operatorArn(accountId, connection)
  const userName = operatorName(connection)
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
        Resource: [
          `arn:aws:iam::${accountId}:mfa/${userName}`,
          `arn:aws:iam::${accountId}:mfa/${userName}-*`,
        ],
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
