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
} from '@aws-sdk/client-ec2'
import { groupSpec } from '../../deployment/topology'
import type { Deployment, Step } from '../../deployment/types'
import { notAttempted } from '../context'
import type { Ec2 } from '../client'
import { need, receipt, tags, unavailable } from './shared'

/**
 * Sends the single mutating call for one fenced network step and returns the
 * identity it produced, if any. There are no provider reads after the mutation.
 */
export async function mutateNetwork(ec2: Ec2, record: Deployment, step: Step): Promise<string | null> {
  const { approval, binding } = record
  switch (step.action) {
    case 'create-vpc': {
      const command = new CreateVpcCommand({
        CidrBlock: approval.cidr,
        InstanceTenancy: approval.tenancy,
        TagSpecifications: tags(record, 'vpc'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.Vpc?.VpcId)
    }
    case 'create-subnet': {
      const zone = approval.zones[step.slot]
      const command = new CreateSubnetCommand({
        VpcId: need(record, 'create-vpc'),
        AvailabilityZoneId: zone.id,
        CidrBlock: zone.cidr,
        TagSpecifications: tags(record, 'subnet'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.Subnet?.SubnetId)
    }
    case 'create-gateway': {
      const command = new CreateInternetGatewayCommand({ TagSpecifications: tags(record, 'internet-gateway') })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.InternetGateway?.InternetGatewayId)
    }
    case 'attach-gateway': {
      const command = new AttachInternetGatewayCommand({
        InternetGatewayId: need(record, 'create-gateway'),
        VpcId: need(record, 'create-vpc'),
      })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'create-route-table': {
      const command = new CreateRouteTableCommand({
        VpcId: need(record, 'create-vpc'),
        TagSpecifications: tags(record, 'route-table'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.RouteTable?.RouteTableId)
    }
    case 'create-route': {
      const command = new CreateRouteCommand({
        RouteTableId: need(record, 'create-route-table'),
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: need(record, 'create-gateway'),
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
        RouteTableId: need(record, 'create-route-table'),
        SubnetId: need(record, 'create-subnet', step.slot),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.AssociationId)
    }
    case 'create-group': {
      const { name, description } = groupSpec(record.id)
      const command = new CreateSecurityGroupCommand({
        GroupName: name,
        Description: description,
        VpcId: need(record, 'create-vpc'),
        TagSpecifications: tags(record, 'security-group'),
      })
      const response = await ec2.write((client, call) => client.send(command, call))
      return receipt(step.action, response.GroupId)
    }
    case 'allow-ingress': {
      const groupId = need(record, 'create-group')
      const ingress = approval.ingress[step.slot]
      const command = new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [
          { IpProtocol: 'tcp', FromPort: ingress.port, ToPort: ingress.port, IpRanges: [{ CidrIp: ingress.cidr }] },
        ],
        TagSpecifications: tags(record, 'security-group-rule'),
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
      const groupId = need(record, 'create-group')
      const command = new DeleteSecurityGroupCommand({ GroupId: groupId })
      const response = await ec2.write((client, call) => client.send(command, call))
      // The output is optional; only an explicit contradiction is unusable evidence.
      if (response.Return === false || (response.GroupId !== undefined && response.GroupId !== groupId)) {
        return unavailable()
      }
      return null
    }
    case 'disassociate-subnet': {
      const command = new DisassociateRouteTableCommand({ AssociationId: need(record, 'associate-subnet', step.slot) })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-subnet': {
      const command = new DeleteSubnetCommand({ SubnetId: need(record, 'create-subnet', step.slot) })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-route-table': {
      const command = new DeleteRouteTableCommand({ RouteTableId: need(record, 'create-route-table') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'detach-gateway': {
      const command = new DetachInternetGatewayCommand({
        InternetGatewayId: need(record, 'create-gateway'),
        VpcId: need(record, 'create-vpc'),
      })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-gateway': {
      const command = new DeleteInternetGatewayCommand({ InternetGatewayId: need(record, 'create-gateway') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    case 'delete-vpc': {
      const command = new DeleteVpcCommand({ VpcId: need(record, 'create-vpc') })
      await ec2.write((client, call) => client.send(command, call))
      return null
    }
    default:
      return notAttempted()
  }
}
