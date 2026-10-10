import { createHash } from 'node:crypto'
import { InstallerError } from '../../diagnostic/error'
import { hasKeys, isRecord } from '../guards'
import { canonical, document, sameJson } from '../json'
import { operatorName } from '../operator'
import { validRegion } from '../types'

export const PERMISSION_VERSION = 3

export const FOUNDATION = Object.freeze({
  path: '/qiln/foundation/',
  maximumCharacters: 6_144,
  maximumVersions: 5,
  instanceType: 'g7e.12xlarge',
})

export interface PermissionEvidence {
  version: number
  region: string
  document: string
  sha256: string
}

export interface PermissionSpec extends PermissionEvidence {
  version: typeof PERMISSION_VERSION
}

export interface PolicyIdentity {
  arn: string
  id: string
  versionId: string
  document: string
  sha256: string
}

export interface PolicySnapshot {
  policy: PolicyIdentity | null
  versions: string[]
}

export interface FoundationGrant {
  spec: PermissionEvidence
  policy: PolicyIdentity
}

type Conditions = Record<string, Record<string, string | string[]>>

interface Statement {
  Effect: 'Allow'
  Action: string[]
  Resource: string | string[]
  Condition?: Conditions
}

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function policyName(connection: string): string {
  return `${operatorName(connection)}-foundation`
}

export function policyArn(accountId: string, connection: string): string {
  if (!/^[0-9]{12}$/.test(accountId)) {
    return invalid()
  }
  return `arn:aws:iam::${accountId}:policy${FOUNDATION.path}${policyName(connection)}`
}

export function validVersionId(value: unknown): value is string {
  return typeof value === 'string' && /^v[1-9][0-9]{0,9}$/.test(value)
}

export function normalize(value: string | undefined): string {
  const normalized = document(value)
  // Canonical JSON has no formatting whitespace. Counting all remaining
  // characters also avoids understating whitespace inside string values.
  if (!/^[\x20-\x7e]+$/.test(normalized) || normalized.length > FOUNDATION.maximumCharacters) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_POLICY_TOO_LARGE',
    })
  }
  return normalized
}

function allow(actions: string[], resources: string | string[], conditions?: Conditions): Statement {
  return {
    Effect: 'Allow',
    Action: actions.map(action => `ec2:${action}`),
    Resource: resources,
    ...(conditions === undefined ? {} : { Condition: conditions }),
  }
}

/**
 * This document prepares regional authority, not a launch request. Exact AMI,
 * placement, counts, storage, egress, and retention still require a separately
 * approved immutable deployment intent.
 */
export function specification(accountId: string, connection: string, region: string): PermissionSpec {
  policyArn(accountId, connection)
  if (!validRegion(region)) {
    return invalid()
  }
  const resource = (type: string) => `arn:aws:ec2:${region}:${accountId}:${type}/*`
  const principal = '${aws:PrincipalArn}'
  const requested: Conditions = {
    StringEquals: {
      'aws:RequestTag/qiln:operator': principal,
    },
  }
  const owned: Conditions = {
    StringEquals: {
      'ec2:ResourceTag/qiln:operator': principal,
    },
  }
  const creationActions = [
    'CreateVpc',
    'CreateSubnet',
    'CreateInternetGateway',
    'CreateRouteTable',
    'CreateSecurityGroup',
    'ImportKeyPair',
    'AllocateAddress',
  ]
  const ruleActions = ['AuthorizeSecurityGroupIngress', 'AuthorizeSecurityGroupEgress']
  const createdResources = [
    'vpc',
    'subnet',
    'internet-gateway',
    'route-table',
    'security-group',
    'security-group-rule',
    'key-pair',
    'elastic-ip',
    'instance',
    'network-interface',
    'volume',
  ].map(resource)
  const statements: Statement[] = [
    allow(
      [
        'DescribeRegions',
        'DescribeAvailabilityZones',
        'DescribeImages',
        'DescribeInstanceTypes',
        'DescribeInstanceTypeOfferings',
        'DescribeInstances',
        'DescribeInstanceStatus',
        'DescribeInstanceAttribute',
        'DescribeVpcs',
        'DescribeVpcAttribute',
        'DescribeSubnets',
        'DescribeRouteTables',
        'DescribeInternetGateways',
        'DescribeSecurityGroups',
        'DescribeSecurityGroupRules',
        'DescribeNetworkInterfaces',
        'DescribeVolumes',
        'DescribeAddresses',
        'DescribeKeyPairs',
      ],
      '*',
      {
        StringEquals: {
          'ec2:Region': region,
        },
      },
    ),
    allow(['CreateVpc'], resource('vpc'), requested),
    // Existing parent VPCs use the ownership fence below, not request tags.
    allow(
      creationActions.filter(action => action !== 'CreateVpc'),
      ['subnet', 'internet-gateway', 'route-table', 'security-group', 'key-pair', 'elastic-ip'].map(resource),
      requested,
    ),
    // These action/resource combinations share an existing-resource owner
    // fence. RunInstances is deliberately excluded to preserve launch checks.
    allow(
      [
        'CreateSubnet',
        'CreateRouteTable',
        'CreateSecurityGroup',
        'AttachInternetGateway',
        'ModifyVpcAttribute',
        'ModifySubnetAttribute',
        'CreateRoute',
        ...ruleActions,
        'RevokeSecurityGroupIngress',
        'RevokeSecurityGroupEgress',
        'AssociateAddress',
        'GetConsoleOutput',
      ],
      [
        'vpc',
        'subnet',
        'internet-gateway',
        'route-table',
        'security-group',
        'elastic-ip',
        'instance',
        'network-interface',
      ].map(resource),
      owned,
    ),
    // Do not authorize gateway route-table association for the single-host model.
    allow(['AssociateRouteTable'], [resource('route-table'), resource('subnet')], owned),
    allow(ruleActions, resource('security-group-rule'), requested),
    // Shared launch inputs cannot require Qiln-owned resource tags. Image-only
    // conditions must not be applied to snapshot authorization.
    allow(['RunInstances'], `arn:aws:ec2:${region}::image/*`, {
      StringEquals: {
        'ec2:ImageType': 'machine',
        'ec2:RootDeviceType': 'ebs',
      },
    }),
    allow(['RunInstances'], `arn:aws:ec2:${region}:*:snapshot/*`),
    allow(['RunInstances'], resource('instance'), {
      StringEquals: {
        ...requested.StringEquals,
        'ec2:InstanceType': FOUNDATION.instanceType,
        'ec2:InstanceMarketType': 'on-demand',
        'ec2:Tenancy': 'default',
        'ec2:MetadataHttpTokens': 'required',
      },
    }),
    allow(['RunInstances'], resource('network-interface'), {
      ...requested,
      Bool: {
        'ec2:AssociatePublicIpAddress': 'false',
      },
    }),
    allow(['RunInstances'], resource('volume'), {
      ...requested,
      Bool: {
        'ec2:Encrypted': 'true',
      },
    }),
    allow(['RunInstances'], [resource('subnet'), resource('security-group'), resource('key-pair')], owned),
    allow(['CreateTags'], createdResources, {
      StringEquals: {
        ...requested.StringEquals,
        'ec2:CreateAction': [...creationActions, ...ruleActions, 'RunInstances'],
      },
    }),
  ]
  const normalized = normalize(
    canonical({
      Version: '2012-10-17',
      Statement: statements,
    }),
  )
  return {
    version: PERMISSION_VERSION,
    region,
    document: normalized,
    sha256: digest(normalized),
  }
}

/**
 * Historical evidence is structurally validated without reconstructing its
 * requirements. It establishes neither current compliance nor live IAM state.
 */
export function isEvidence(value: unknown): value is PermissionEvidence {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['version', 'region', 'document', 'sha256']) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.region !== 'string' ||
    !validRegion(value.region) ||
    typeof value.document !== 'string' ||
    typeof value.sha256 !== 'string'
  ) {
    return false
  }
  try {
    return normalize(value.document) === value.document && digest(value.document) === value.sha256
  } catch {
    return false
  }
}

export function isSpec(value: unknown, accountId: string, connection: string): value is PermissionSpec {
  if (!isEvidence(value) || value.version !== PERMISSION_VERSION) {
    return false
  }
  try {
    return sameJson(value, specification(accountId, connection, value.region))
  } catch {
    return false
  }
}

export function isPolicy(value: unknown): value is PolicyIdentity {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['arn', 'id', 'versionId', 'document', 'sha256']) ||
    typeof value.arn !== 'string' ||
    !/^arn:aws:iam::[0-9]{12}:policy\/[A-Za-z0-9+=,.@_/-]+$/.test(value.arn) ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9]{1,128}$/.test(value.id) ||
    !validVersionId(value.versionId) ||
    typeof value.document !== 'string' ||
    typeof value.sha256 !== 'string'
  ) {
    return false
  }
  try {
    return normalize(value.document) === value.document && digest(value.document) === value.sha256
  } catch {
    return false
  }
}

export function isSnapshot(value: unknown): value is PolicySnapshot {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['policy', 'versions']) ||
    (value.policy !== null && !isPolicy(value.policy)) ||
    !Array.isArray(value.versions) ||
    value.versions.some(version => !validVersionId(version)) ||
    new Set(value.versions).size !== value.versions.length ||
    value.versions.length > FOUNDATION.maximumVersions
  ) {
    return false
  }
  if (value.policy === null) {
    return value.versions.length === 0
  }
  return value.versions.length > 0 && value.versions.includes(value.policy.versionId)
}

export function isGrant(value: unknown, accountId: string, connection: string): value is FoundationGrant {
  return (
    isRecord(value) &&
    hasKeys(value, ['spec', 'policy']) &&
    isEvidence(value.spec) &&
    isPolicy(value.policy) &&
    value.policy.arn === policyArn(accountId, connection) &&
    value.policy.document === value.spec.document &&
    value.policy.sha256 === value.spec.sha256
  )
}

export function sameSnapshot(left: PolicySnapshot, right: PolicySnapshot): boolean {
  return sameJson(left, right)
}

export function reconciliationMode(
  prior: PolicySnapshot,
  desired: PermissionEvidence,
): 'enroll' | 'replace' | 'none' | null {
  if (!isSnapshot(prior) || !isEvidence(desired)) {
    return null
  }
  if (prior.policy === null) {
    return 'enroll'
  }
  if (prior.policy.document === desired.document && prior.policy.sha256 === desired.sha256) {
    return 'none'
  }
  return 'replace'
}
