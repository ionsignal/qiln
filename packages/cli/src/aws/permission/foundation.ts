import { allow, render, type Conditions, type Statement } from './statement'

/**
 * This document prepares regional networking authority, not a launch or
 * removal request. Deleting VPCs, subnets, internet gateways, route tables, and
 * security groups is limited to resources tagged for this operator, and VPC
 * deletion additionally requires the managed-by and deployment tags, so the
 * deployment record remains the per-deployment gate. Launch, instance, storage,
 * key, and address authority lives in the compute policy. Allows combine across
 * policies, so the two documents must never overlap. Reads for every resource
 * type stay here.
 */
export function foundationPolicy(accountId: string, region: string): string {
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
  // Creation checks the request tags and deletion checks the tags already on
  // the VPC. '?*' requires a nonempty deployment tag.
  const vpcTags = (prefix: 'aws:RequestTag' | 'ec2:ResourceTag'): Conditions => ({
    StringEquals: {
      [`${prefix}/qiln:operator`]: principal,
      [`${prefix}/qiln:managed-by`]: 'qiln-cli',
    },
    StringLike: {
      [`${prefix}/qiln:deployment`]: '?*',
    },
  })
  const vpcRequested = vpcTags('aws:RequestTag')
  const vpcOwned = vpcTags('ec2:ResourceTag')
  const creationActions = [
    'CreateVpc',
    'CreateSubnet',
    'CreateInternetGateway',
    'CreateRouteTable',
    'CreateSecurityGroup',
  ]
  const ruleActions = ['AuthorizeSecurityGroupIngress', 'AuthorizeSecurityGroupEgress']
  const createdResources = [
    'vpc',
    'subnet',
    'internet-gateway',
    'route-table',
    'security-group',
    'security-group-rule',
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
    allow(['CreateVpc'], resource('vpc'), vpcRequested),
    // VPC deletion keeps the stronger managed-by and deployment tag fence.
    allow(['DeleteVpc'], resource('vpc'), vpcOwned),
    // Existing parent VPCs use the ownership fence below, not request tags.
    allow(
      creationActions.filter(action => action !== 'CreateVpc'),
      ['subnet', 'internet-gateway', 'route-table', 'security-group'].map(resource),
      requested,
    ),
    // These action/resource combinations share an existing-resource owner
    // fence. The trailing network cleanup actions need only the operator tag,
    // since the VPC deletion fence and the deployment record gate each removal.
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
        'DetachInternetGateway',
        'DeleteSubnet',
        'DeleteInternetGateway',
        'DeleteRouteTable',
        'DeleteSecurityGroup',
      ],
      ['vpc', 'subnet', 'internet-gateway', 'route-table', 'security-group'].map(resource),
      owned,
    ),
    // Do not authorize gateway route-table association for the single-host model.
    allow(['AssociateRouteTable', 'DisassociateRouteTable'], [resource('route-table'), resource('subnet')], owned),
    allow(ruleActions, resource('security-group-rule'), requested),
    allow(['CreateTags'], createdResources, {
      StringEquals: {
        ...requested.StringEquals,
        'ec2:CreateAction': [...creationActions, ...ruleActions],
      },
    }),
  ]
  return render(statements)
}
