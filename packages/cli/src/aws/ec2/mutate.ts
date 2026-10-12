import {
  AssociateRouteTableCommand,
  AttachInternetGatewayCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateInternetGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  DeleteInternetGatewayCommand,
  DeleteRouteTableCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  DetachInternetGatewayCommand,
  DisassociateRouteTableCommand,
  type ResourceType,
  type TagSpecification,
} from '@aws-sdk/client-ec2'
import { InstallerError } from '../../diagnostic/error'
import { groupSpec, resourceId } from '../deployment/topology'
import { isReceipt, type Deployment, type Step } from '../deployment/types'
import { notAttempted } from './context'
import type { Ec2 } from './client'
import type { Action } from '../deployment/graph'

function unavailable(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE',
  })
}

function receipt(action: Action, id: unknown): string {
  if (typeof id !== 'string' || !isReceipt(action, id)) {
    return unavailable()
  }
  return id
}

/**
 * Sends the single mutating call for one fenced step and returns the identity
 * it produced, if any. Prerequisite identities come from the ledger; a missing
 * one fails before dispatch. There are no provider reads after the mutation.
 */
export async function mutate(ec2: Ec2, record: Deployment, step: Step): Promise<string | null> {
  const { approval, binding } = record
  const tags = (type: ResourceType): TagSpecification[] => [{ ResourceType: type, Tags: approval.tags }]
  const need = (action: Action, slot = 0): string => resourceId(record, action, slot) ?? notAttempted()
  switch (step.action) {
    case 'create-vpc': {
      const command = new CreateVpcCommand({
        CidrBlock: approval.cidr,
        InstanceTenancy: approval.tenancy,
        TagSpecifications: tags('vpc'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.Vpc?.VpcId)
    }
    case 'create-subnet': {
      const zone = approval.zones[step.slot]
      const command = new CreateSubnetCommand({
        VpcId: need('create-vpc'),
        AvailabilityZoneId: zone.id,
        CidrBlock: zone.cidr,
        TagSpecifications: tags('subnet'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.Subnet?.SubnetId)
    }
    case 'create-gateway': {
      const command = new CreateInternetGatewayCommand({ TagSpecifications: tags('internet-gateway') })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.InternetGateway?.InternetGatewayId)
    }
    case 'attach-gateway': {
      const command = new AttachInternetGatewayCommand({
        InternetGatewayId: need('create-gateway'),
        VpcId: need('create-vpc'),
      })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'create-route-table': {
      const command = new CreateRouteTableCommand({
        VpcId: need('create-vpc'),
        TagSpecifications: tags('route-table'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.RouteTable?.RouteTableId)
    }
    case 'create-route': {
      const command = new CreateRouteCommand({
        RouteTableId: need('create-route-table'),
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: need('create-gateway'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      if (response.Return !== true) {
        return unavailable()
      }
      return null
    }
    case 'associate-subnet': {
      // Always a subnet association, never a gateway association.
      const command = new AssociateRouteTableCommand({
        RouteTableId: need('create-route-table'),
        SubnetId: need('create-subnet', step.slot),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.AssociationId)
    }
    case 'create-group': {
      const { name, description } = groupSpec(record.id)
      const command = new CreateSecurityGroupCommand({
        GroupName: name,
        Description: description,
        VpcId: need('create-vpc'),
        TagSpecifications: tags('security-group'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.GroupId)
    }
    case 'allow-ingress': {
      const groupId = need('create-group')
      const ingress = approval.ingress[step.slot]
      const command = new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [
          { IpProtocol: 'tcp', FromPort: ingress.port, ToPort: ingress.port, IpRanges: [{ CidrIp: ingress.cidr }] },
        ],
        TagSpecifications: tags('security-group-rule'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      const rules = response.SecurityGroupRules ?? []
      if (response.Return !== true || rules.length !== 1) {
        return unavailable()
      }
      const rule = rules[0]
      if (
        rule.GroupId !== groupId ||
        rule.GroupOwnerId !== binding.accountId ||
        rule.IsEgress !== false ||
        rule.IpProtocol !== 'tcp' ||
        rule.FromPort !== ingress.port ||
        rule.ToPort !== ingress.port ||
        rule.CidrIpv4 !== ingress.cidr
      ) {
        return unavailable()
      }
      return receipt(step.action, rule.SecurityGroupRuleId)
    }
    case 'delete-group': {
      const groupId = need('create-group')
      const command = new DeleteSecurityGroupCommand({ GroupId: groupId })
      const response = await ec2.write((client, call) => client.send(command, call))
      // The output is optional; only an explicit contradiction is unusable evidence.
      if (response.Return === false || (response.GroupId !== undefined && response.GroupId !== groupId)) {
        return unavailable()
      }
      return null
    }
    case 'disassociate-subnet': {
      const command = new DisassociateRouteTableCommand({ AssociationId: need('associate-subnet', step.slot) })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-subnet': {
      const command = new DeleteSubnetCommand({ SubnetId: need('create-subnet', step.slot) })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-route-table': {
      const command = new DeleteRouteTableCommand({ RouteTableId: need('create-route-table') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'detach-gateway': {
      const command = new DetachInternetGatewayCommand({
        InternetGatewayId: need('create-gateway'),
        VpcId: need('create-vpc'),
      })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-gateway': {
      const command = new DeleteInternetGatewayCommand({ InternetGatewayId: need('create-gateway') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-vpc': {
      const command = new DeleteVpcCommand({ VpcId: need('create-vpc') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
  }
}
