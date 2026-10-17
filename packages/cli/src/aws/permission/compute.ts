import { AWS_SPEC } from '../spec'
import { allow, render, type Conditions, type Statement } from './statement'

/**
 * This document prepares compute authority across all commercial AWS regions,
 * not a launch request. The deployment region recorded by Qiln is an execution
 * gate, not an IAM boundary. Exact AMI, placement, counts, egress, volume
 * settings, and retention still require a separately approved immutable
 * deployment intent. Volume type, size, IOPS, and throughput are ceilings on
 * each individual request, not aggregate storage or spending limits, and they
 * are the only volume values this document reads. Changing deployment defaults
 * within them leaves this document and its digest unchanged. Qiln gets no
 * DeleteVolume, DetachVolume, volume modification, snapshot, or KMS authority.
 * Terminating an instance can still delete its attached volumes according to
 * DeleteOnTermination, so that flag is verified in the launch request, not
 * here. Reads live in the foundation policy and the two documents must not
 * overlap.
 */
export function computePolicy(accountId: string): string {
  const { volumes } = AWS_SPEC.permission
  const resource = (type: string) => `arn:aws:ec2:*:${accountId}:${type}/*`
  const principal = '${aws:PrincipalArn}'
  const launchTypes = [...AWS_SPEC.permission.instanceTypes]
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
  const volumeCeilings = (maximumGiB: number): Conditions => ({
    StringEquals: {
      ...requested.StringEquals,
      'ec2:VolumeType': [...volumes.types],
    },
    NumericLessThanEquals: {
      'ec2:VolumeSize': String(maximumGiB),
      'ec2:VolumeIops': String(volumes.maximumIops),
      'ec2:VolumeThroughput': String(volumes.maximumThroughput),
    },
  })
  const statements: Statement[] = [
    // Shared launch inputs cannot require Qiln-owned resource tags. Image-only
    // conditions must not be applied to snapshot authorization.
    allow(['RunInstances'], 'arn:aws:ec2:*::image/*', {
      StringEquals: {
        'ec2:ImageType': 'machine',
        'ec2:RootDeviceType': 'ebs',
      },
    }),
    allow(['RunInstances'], 'arn:aws:ec2:*:*:snapshot/*'),
    allow(['RunInstances'], resource('instance'), {
      StringEquals: {
        ...requested.StringEquals,
        'ec2:InstanceType': launchTypes,
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
    allow(['RunInstances'], resource('volume'), volumeCeilings(volumes.maximumRootGiB)),
    allow(['RunInstances'], [resource('subnet'), resource('security-group'), resource('key-pair')], owned),
    allow(['CreateVolume'], resource('volume'), volumeCeilings(volumes.maximumDataGiB)),
    allow(['AttachVolume'], [resource('instance'), resource('volume')], owned),
    allow(['TerminateInstances', 'GetConsoleOutput'], resource('instance'), owned),
    allow(['ImportKeyPair'], resource('key-pair'), requested),
    allow(['DeleteKeyPair'], resource('key-pair'), owned),
    allow(['AllocateAddress'], resource('elastic-ip'), requested),
    allow(
      ['AssociateAddress', 'DisassociateAddress'],
      [resource('elastic-ip'), resource('instance'), resource('network-interface')],
      owned,
    ),
    allow(['ReleaseAddress'], resource('elastic-ip'), owned),
    allow(
      ['CreateTags'],
      ['instance', 'network-interface', 'volume', 'key-pair', 'elastic-ip'].map(resource),
      {
        StringEquals: {
          ...requested.StringEquals,
          'ec2:CreateAction': ['RunInstances', 'CreateVolume', 'ImportKeyPair', 'AllocateAddress'],
        },
      },
    ),
  ]
  return render(statements)
}
