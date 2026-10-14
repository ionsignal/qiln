import { AWS_SPEC } from '../spec'
import { allow, render, type Conditions, type Statement } from './statement'

/**
 * This document prepares regional compute authority, not a launch request.
 * Exact AMI, placement, counts, egress, and retention still require a
 * separately approved immutable deployment intent. Qiln gets no DeleteVolume,
 * DetachVolume, volume modification, snapshot, or KMS authority. Terminating an
 * instance can still delete its attached volumes according to
 * DeleteOnTermination, so that flag is verified in the launch request, not here.
 * Reads live in the foundation policy and the two documents must not overlap.
 */
export function computePolicy(accountId: string, region: string): string {
  const resource = (type: string) => `arn:aws:ec2:${region}:${accountId}:${type}/*`
  const principal = '${aws:PrincipalArn}'
  const { instanceType, storage } = AWS_SPEC.compute
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
  // Numeric volume keys deny when absent, so the launch and volume requests
  // must state type, size, IOPS, and throughput explicitly.
  const volume = (sizeGiB: number): Conditions => ({
    StringEquals: {
      ...requested.StringEquals,
      'ec2:VolumeType': storage.volumeType,
    },
    NumericEquals: {
      'ec2:VolumeSize': String(sizeGiB),
      'ec2:VolumeIops': String(storage.iops),
      'ec2:VolumeThroughput': String(storage.throughput),
    },
  })
  const statements: Statement[] = [
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
        'ec2:InstanceType': instanceType,
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
    allow(['RunInstances'], resource('volume'), volume(storage.rootSizeGiB)),
    allow(['RunInstances'], [resource('subnet'), resource('security-group'), resource('key-pair')], owned),
    // The data volume is created independently, once, and attached per host.
    allow(['CreateVolume'], resource('volume'), volume(storage.dataSizeGiB)),
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
