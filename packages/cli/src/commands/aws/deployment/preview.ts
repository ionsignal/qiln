import type { DiagnosticFact } from '../../../diagnostic/error'
import type { ImagePin } from '../../../aws/ami'
import { deploymentName } from '../../../aws/deployment/alias'
import type { HostPlan } from '../../../aws/deployment/host/types'
import type { HostProposal, ImageDevice, ImageEvidence, InstanceTypeEvidence } from '../../../aws/deployment/proposal/types'
import { AWS_SPEC } from '../../../aws/spec'
import type { AwsIdentity } from '../../../aws/types'
import type { Reporter } from '../../../terminal/reporter'

const { compute } = AWS_SPEC

export interface PreviewTarget {
  alias: string
  identity: AwsIdentity
}

function list(values: readonly string[]): string {
  return values.join(', ') || 'none reported'
}

function deviceSummary(device: ImageDevice): string {
  const { ebs } = device
  if (ebs === null) {
    return `${device.deviceName} · ${device.noDevice ? 'suppressed' : (device.virtualName ?? 'no EBS mapping')}`
  }
  return [
    device.deviceName,
    ebs.snapshotId ?? 'no snapshot',
    `${ebs.volumeSizeGiB ?? 'size not reported'} GiB`,
    ebs.volumeType ?? 'type not reported',
    `encrypted ${ebs.encrypted ?? 'not reported'}`,
    `delete on termination ${ebs.deleteOnTermination ?? 'not reported'}`,
  ].join(' · ')
}

function volumeSummary(volume: HostPlan['root'] | HostPlan['data']): string {
  return `${volume.sizeGiB} GiB ${volume.volumeType} · ${volume.iops} IOPS · ${volume.throughput} MiB/s`
}

function termination(deleteOnTermination: boolean): string {
  return deleteOnTermination ? 'deleted on termination' : 'retained after termination'
}

function imageFacts(image: ImageEvidence | null, pin: ImagePin): DiagnosticFact[] {
  if (image === null) {
    return [['AMI', 'the pinned image was not returned; see findings']]
  }
  return [
    ['AMI', image.id],
    ['Image name', image.name],
    ['Publisher', `${image.ownerId} · ${image.ownerId === pin.ownerId ? 'equals' : 'differs from'} the pinned owner account`],
    ['Created', image.createdAt],
    [
      'Properties',
      `${image.architecture} · ${image.state} · ${image.imageType} · ${image.rootDeviceType} root ${image.rootDeviceName ?? 'unnamed'} · ${image.virtualizationType}`,
    ],
    [
      'ENA / boot mode',
      `${image.enaSupport ?? 'not reported'} · ${image.bootMode ?? 'not reported (documented x86 default: legacy-bios)'}`,
    ],
    ['Deprecation', image.deprecationTime ?? 'none reported'],
    ['Product codes', image.productCodes.join(', ') || 'none'],
    ...image.devices.map((device): DiagnosticFact => ['Image device', deviceSummary(device)]),
  ]
}

function instanceFacts(instance: InstanceTypeEvidence | null): DiagnosticFact[] {
  if (instance === null) {
    return [['Instance type', `${compute.instanceType} was not returned for this region`]]
  }
  const gpus = instance.gpus.map(gpu => `${gpu.count} x ${gpu.manufacturer} ${gpu.name}, ${gpu.memoryMiB} MiB each`)
  return [
    ['Instance type', `${instance.name} · usage ${list(instance.usageClasses)}`],
    ['CPU / memory', `${instance.vcpus} vCPUs · ${instance.memoryMiB / 1_024} GiB`],
    ['GPUs', `${list(gpus)} · total ${instance.gpuMemoryMiB ?? 'not reported'} MiB`],
    [
      'Compatibility',
      `${list(instance.architectures)} · ${list(instance.rootDeviceTypes)} root · ${list(instance.virtualizationTypes)} · ENA ${instance.enaSupport ?? 'not reported'} · boot ${list(instance.bootModes)}`,
    ],
    [
      'Storage support',
      `EBS optimized ${instance.ebsSupport ?? 'not reported'} · instance storage ${instance.instanceStorageGB === null ? 'none reported' : `${instance.instanceStorageGB} GB`}`,
    ],
  ]
}

function documentedFacts(): DiagnosticFact[] {
  const { documented, release, documentation } = compute.image
  return [
    ['Release', release],
    ['OS', documented.os],
    ['NVIDIA driver', documented.driver],
    ['CUDA', documented.cuda],
    ['Kernel', documented.kernel],
    ['Documentation', documentation],
  ]
}

function networkFacts(plan: HostPlan, proposal: HostProposal, target: PreviewTarget): DiagnosticFact[] {
  const host = plan.zones[plan.hostSlot]
  const { network, metadata } = plan
  return [
    ['Instance', `${plan.count} ${plan.instanceType} · ${plan.purchase} · default tenancy`],
    [
      'Availability Zone',
      `${host.name} (${host.id}) · offered in selected AZ; capacity unverified; never changed automatically`,
    ],
    ['Host subnet', host.cidr],
    ['VPC CIDR', plan.cidr],
    ...plan.zones.map((zone): DiagnosticFact => ['Subnet', `${zone.name} (${zone.id}) · ${zone.cidr}`]),
    ...proposal.excludedZones.map((zone): DiagnosticFact => ['Excluded zone', `${zone.name} (${zone.id}) · ${zone.state}`]),
    ['Routing', 'internet gateway attached to the VPC · 0.0.0.0/0 routed to it · route table associated with every subnet'],
    ['Security group', 'one host group'],
    ...plan.ingress.map((rule): DiagnosticFact => ['Ingress', `tcp ${rule.port} from ${rule.cidr}`]),
    ['Egress', "allow-all IPv4 (AWS's initial rule, retained)"],
    [
      'Network interface',
      `one new primary interface in the host subnet · device index ${network.deviceIndex} · network card ${network.networkCardIndex} · ${network.associatePublicIp ? 'automatic public IPv4' : 'no automatic public IPv4'} · ${termination(network.deleteOnTermination)}`,
    ],
    [
      'Public address',
      `Elastic IP, intended · reassociation of an address bound elsewhere ${plan.elasticIp.allowReassociation ? 'allowed' : 'refused'}`,
    ],
    [
      'Instance metadata',
      `endpoint ${metadata.httpEndpoint} · tokens ${metadata.httpTokens} · hop limit ${metadata.httpPutResponseHopLimit} · IPv6 ${metadata.httpProtocolIpv6} · tags ${metadata.instanceMetadataTags} · no instance profile`,
    ],
    [
      'Tags',
      `qiln:operator=${target.identity.arn}, qiln:managed-by=qiln-cli, qiln:deployment=<assigned at approval> · applied to ${plan.tagged.join(', ')}`,
    ],
  ]
}

/**
 * Instance storage is local to the host and ephemeral, so it is reported apart
 * from the durable root and data volumes. Omitting an image mapping does not
 * stop NVMe local disks from appearing on the instance.
 */
function instanceStorageFact(proposal: HostProposal): DiagnosticFact {
  const mapped = proposal.instanceStore.map(device => `${device.deviceName} (${device.virtualName})`)
  const reported = proposal.instanceType?.instanceStorageGB ?? null
  return [
    'Instance storage',
    `Ephemeral and outside the durable storage plan; contents are lost when the instance stops or terminates. Image mappings: ${mapped.join(', ') || 'none'}. Instance type reports ${reported === null ? 'none' : `${reported} GB`}. Local disks may appear on the host regardless of image mappings.`,
  ]
}

function storageFacts(plan: HostPlan, proposal: HostProposal): DiagnosticFact[] {
  const { root, data } = plan
  return [
    [
      'Root volume',
      `${volumeSummary(root)} · ${root.deviceName} from snapshot ${root.snapshotId} · ${termination(root.deleteOnTermination)} (set at launch)`,
    ],
    [
      'Data volume',
      `${volumeSummary(data)} · attached as ${data.deviceName} · ${termination(data.deleteOnTermination)} (expected from the attach-time default and verified after attach; Qiln cannot change it)`,
    ],
    instanceStorageFact(proposal),
    ['Encryption', 'No KMS authority or encryption requirement; account defaults and the image snapshot settings apply.'],
    [
      'Storage cleanup',
      'Qiln has no DeleteVolume or DetachVolume authority, so a retained data volume must be deleted outside Qiln. Complete storage cleanup is not promised.',
    ],
  ]
}

function accessFacts(plan: HostPlan): DiagnosticFact[] {
  const { key } = plan
  return [
    [
      'Admin SSH key',
      `One ${key.algorithm} OpenSSH key per deployment, generated locally and bound to the deployment ID. Passphrase: ${key.passphrase}. The private key stays in protected local state (${key.protection}) and is not otherwise encrypted; AWS receives only the public half.`,
    ],
    ['Login user', 'ubuntu'],
    [
      'Host identity',
      "Verified separately from the client key, against host-key fingerprints read through authenticated AWS console output, before authentication. Missing evidence blocks verified SSH. This preview generates and imports nothing.",
    ],
  ]
}

/**
 * What a later, separately approved removal would and would not do. Retention
 * is stated here so approval cannot be read as a promise that every resource
 * disappears.
 */
function removalFacts(plan: HostPlan): DiagnosticFact[] {
  const { root, data, network } = plan
  return [
    ['Instance', 'Terminated only by a separately approved removal. Termination is verified by observation, never assumed from the request.'],
    [
      'Root volume',
      `${root.deleteOnTermination ? 'Deleted by AWS with the instance (set at launch and verified)' : 'Retained after termination'}; reported only once observed absent.`,
    ],
    [
      'Primary interface',
      `${network.deleteOnTermination ? 'Deleted by AWS with the instance' : 'Retained after termination'}; reported only once observed absent.`,
    ],
    [
      'Data volume',
      `${data.deleteOnTermination ? 'Deleted with the instance' : 'Retained by design, identified, and observed present and unattached after termination'}. Never reported as removed or absent, and it keeps incurring charges until it is deleted outside Qiln.`,
    ],
    ['Elastic IP', 'Disassociated, then released. Each is a separate effect and is verified separately.'],
    [
      'AWS key pair',
      'Deleted. This does not remove the key from the guest or delete the local private key, and it is not SSH revocation.',
    ],
    ['Network', 'VPC, subnets, internet gateway, route table, and security group deleted in dependency order. AWS refusal is the only dependency gate.'],
    [
      'Outcome report',
      'Instance termination, root volume, data volume, address, key pair, network, and any unresolved effects are reported separately.',
    ],
    ['Spend', 'Approval is not automated spend protection, and no recurring cost estimate is shown.'],
  ]
}

/**
 * Renders the in-memory proposal. Observed AWS metadata, documented release
 * expectations, and intended future behavior sit in separate sections, and no
 * documented or intended value carries a verified badge. Intended behavior is
 * rendered only from the frozen plan, which exists only when nothing blocks.
 * The pinned AMI comes from the committed regional index, not from AWS, so it
 * is shown beside the region and appears even when AWS did not return the image.
 */
export function reportProposal(reporter: Reporter, proposal: HostProposal, target: PreviewTarget): void {
  reporter.section('Proposed GPU host — execution unavailable')
  reporter.facts([
    ['Account', target.identity.accountId],
    ['Operator', target.identity.arn],
    ['Local alias', `${deploymentName(target.alias)} (not reserved)`],
    ['Permission region', proposal.region],
    [
      'Pinned AMI',
      `${proposal.pin.imageId} · owner ${proposal.pin.ownerId} · committed index entry for ${proposal.region}; not searched or substituted`,
    ],
    ['Discovered', proposal.discoveredAt],
  ])
  reporter.space()
  reporter.info('Read-only preview. Nothing below has been created, approved, or reserved.')
  reporter.section('Observed in AWS (read-only, point in time)')
  reporter.facts([...imageFacts(proposal.image, proposal.pin), ...instanceFacts(proposal.instanceType)])
  reporter.section('Documented by AWS (not verified on a host)')
  reporter.facts(documentedFacts())
  reporter.space()
  reporter.info(
    'These are release-note expectations, not observed guest state. The image also includes an SSM agent; Qiln grants no instance profile and does not use SSM.',
  )
  const { plan } = proposal
  if (plan === null) {
    reporter.section('Proposed host configuration (intended)')
    reporter.info(
      'Not shown: a blocking finding prevents a complete launch configuration. Intended settings are displayed only from a complete frozen plan.',
    )
  } else {
    reporter.section('Proposed placement and network (intended)')
    reporter.facts(networkFacts(plan, proposal, target))
    reporter.section('Proposed storage and access (intended)')
    reporter.facts([...storageFacts(plan, proposal), ...accessFacts(plan)])
    reporter.section('Intended removal (separate approval)')
    reporter.facts(removalFacts(plan))
  }
  reporter.section('Findings')
  if (proposal.findings.length === 0) {
    reporter.info('No blocking or review findings.')
  } else {
    reporter.facts(
      proposal.findings.map((finding): DiagnosticFact => [finding.severity === 'blocker' ? 'Blocker' : 'Review', finding.message]),
    )
  }
  reporter.space()
  reporter.info(
    'Quotas, capacity, pricing, guest operation, and network reachability were not verified. An offering is not a capacity reservation.',
  )
  reporter.info(
    'No instance profile, operator-credential delivery, host preparation, Qiln installation, HTTPS service, or capsule-service readiness is included.',
  )
}
