import { AWS_SPEC } from '../../../aws/spec'
import { deploymentName } from '../../../aws/deployment/volume/alias'
import type { ImagePin } from '../../../aws/ami'
import type { AwsIdentity } from '../../../aws/types'
import type { Reporter } from '../../../terminal/reporter'
import type { DiagnosticFact } from '../../../diagnostic/error'
import type { HostPlan } from '../../../aws/deployment/host/types'
import type { Reuse } from '../../../aws/deployment/volume/reuse'
import type { HostProposal, ImageDevice, ImageEvidence, InstanceTypeEvidence } from '../../../aws/deployment/proposal/types'

const { compute } = AWS_SPEC

/**
 * `retained` is the package architecture of the Incus installation
 * that a reused volume preserves, or null when none is recorded.
 */
export interface PreviewTarget {
  alias: string
  identity: AwsIdentity
  previous: string | null
  retained: string | null
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
    return [['Instance type', `${compute.defaultInstanceType} was not returned for this region`]]
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

/**
 * Only what the repository pins for the image. None of it is observed on a
 * host, so it carries no verified badge.
 */
function reviewedFacts(): DiagnosticFact[] {
  const { name, release, owner, architecture } = compute.image
  return [
    ['Image name', name],
    ['Release', release],
    ['Publisher account', owner],
    ['Architecture', architecture],
  ]
}

/**
 * The launch candidates in the order they are tried. A retained data volume
 * fixes the zone, so it has exactly one candidate and never falls back. An
 * offering is not a capacity reservation, so capacity stays unverified.
 */
function launchFacts(plan: HostPlan, proposal: HostProposal): DiagnosticFact[] {
  const candidates = plan.hostSlots.map(slot => plan.zones[slot])
  const policy =
    proposal.reuse === null
      ? `${candidates.length} ${candidates.length === 1 ? 'zone offers' : 'zones offer'} ${plan.instanceType}, tried once each in zone ID order; the next is tried only after AWS definitively refuses capacity in the previous one`
      : 'fixed by the retained data volume; offered in this AZ; no other zone is tried'
  return [
    ['Launch zones', `${policy}; capacity unverified`],
    ...candidates.map(
      (zone, index): DiagnosticFact => [`Launch candidate ${index + 1}`, `${zone.name} (${zone.id}) · host subnet ${zone.cidr}`],
    ),
  ]
}

function networkFacts(plan: HostPlan, proposal: HostProposal, target: PreviewTarget): DiagnosticFact[] {
  const { network, metadata } = plan
  return [
    ['Instance', `${plan.count} ${plan.instanceType} · ${plan.purchase} · default tenancy`],
    ...launchFacts(plan, proposal),
    ['VPC CIDR', plan.cidr],
    ...plan.zones.map((zone): DiagnosticFact => ['Subnet', `${zone.name} (${zone.id}) · ${zone.cidr}`]),
    ...proposal.excludedZones.map((zone): DiagnosticFact => ['Excluded zone', `${zone.name} (${zone.id}) · ${zone.state}`]),
    ['Routing', 'internet gateway attached to the VPC · 0.0.0.0/0 routed to it · route table associated with every subnet'],
    ['Security group', 'one host group'],
    ...plan.ingress.map((rule): DiagnosticFact => ['Ingress', `tcp ${rule.port} from ${rule.cidr}`]),
    ['Egress', "allow-all IPv4 (AWS's initial rule, retained)"],
    [
      'Network interface',
      `one new primary interface in the subnet of the launched zone · device index ${network.deviceIndex} · network card ${network.networkCardIndex} · ${network.associatePublicIp ? 'automatic public IPv4' : 'no automatic public IPv4'} · ${termination(network.deleteOnTermination)}`,
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

/**
 * A reused volume is named by identity and keeps its original tags. The
 * previous deployment is shown by its immutable ID, never only by its alias.
 * The retained Incus architecture is judged against the image in the findings.
 */
function dataVolumeFacts(plan: HostPlan, reuse: Reuse | null, retained: string | null): DiagnosticFact[] {
  const { data } = plan
  if (reuse === null) {
    return [
      [
        'Data volume',
        `${volumeSummary(data)} · created in the zone that the instance launches in, after the launch succeeds · attached as ${data.deviceName} · ${termination(data.deleteOnTermination)} (expected from the attach-time default and verified after attach; Qiln cannot change it)`,
      ],
    ]
  }
  return [
    [
      'Data volume',
      `reuse ${reuse.volumeId} · ${volumeSummary(data)} · attached as ${data.deviceName} · ${termination(data.deleteOnTermination)} (verified after attach; Qiln cannot change it)`,
    ],
    [
      'Previous deployment',
      `${reuse.from} · removal verified, and a fresh AWS read found the volume available and unattached`,
    ],
    [
      'Retained Incus',
      retained === null
        ? 'no Incus installation is recorded on this volume; a later prepare initializes a fresh one'
        : `${retained} installation preserved on this volume · the reviewed image must have the same architecture, which is judged in the findings`,
    ],
    [
      'Volume tags',
      'The original tags are kept, so the volume stays tagged for the previous deployment. Nothing is retagged, copied, resized, or replaced, and its contents were not inspected.',
    ],
  ]
}

function storageFacts(plan: HostPlan, proposal: HostProposal, target: PreviewTarget): DiagnosticFact[] {
  const { root } = plan
  return [
    [
      'Root volume',
      `${volumeSummary(root)} · ${root.deviceName} from snapshot ${root.snapshotId} · ${termination(root.deleteOnTermination)} (set at launch)`,
    ],
    ...dataVolumeFacts(plan, proposal.reuse, target.retained),
    instanceStorageFact(proposal),
    ['Encryption', 'No KMS authority or encryption requirement; account defaults and the image snapshot settings apply.'],
    [
      'Storage cleanup',
      'Qiln has no DeleteVolume or DetachVolume authority, so a retained data volume must be deleted outside Qiln. Complete storage cleanup is not promised.',
    ],
  ]
}

function accessFacts(plan: HostPlan): DiagnosticFact[] {
  const { key, bootstrap } = plan
  return [
    [
      'Admin SSH key',
      `One ${key.algorithm} OpenSSH key per deployment, generated locally after approval and bound to the deployment ID by fingerprint. Passphrase: ${key.passphrase}. The private key stays in protected local state (${key.protection}) and is not otherwise encrypted; AWS receives only the public half, as a key pair.`,
    ],
    [
      'Admin account',
      `${bootstrap.user} · password locked · SSH password authentication disabled · passwordless sudo`,
    ],
    ['Admin login', 'SSH key from the AWS key pair, supplied through instance metadata'],
    [
      'Cloud-init',
      `declarative user-data, sent exactly as approved · SHA-256 ${bootstrap.sha256} · no commands, packages, storage, private keys, or credentials · effective guest settings are not verified`,
    ],
    [
      'SSH access',
      'Create and inspect make no SSH connection. The key is imported for the launch only: no host-identity verification or guest inspection occurs.',
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
 * Renders the in-memory proposal. Observed AWS metadata, reviewed repository
 * expectations, and intended future behavior sit in separate sections, and no
 * reviewed or intended value carries a verified badge. Intended behavior is
 * rendered only from the frozen plan, which exists only when nothing blocks.
 * The pinned AMI comes from the committed regional index, not from AWS, so it
 * is shown beside the region and appears even when AWS did not return the image.
 */
export function reportProposal(reporter: Reporter, proposal: HostProposal, target: PreviewTarget): void {
  const name = deploymentName(target.alias)
  reporter.section('Proposed host')
  reporter.facts([
    ['Account', target.identity.accountId],
    ['Operator', target.identity.arn],
    [
      'Local alias',
      target.previous === null
        ? `${name} (reserved when approved)`
        : `${name} (taken over from deployment ${target.previous} when approved; the older record stays available by ID)`,
    ],
    ['Deployment region', proposal.region],
    [
      'Pinned AMI',
      `${proposal.pin.imageId} · owner ${proposal.pin.ownerId} · committed index entry for ${proposal.region}; not searched or substituted`,
    ],
    ['Discovered', proposal.discoveredAt],
  ])
  reporter.space()
  reporter.info('Proposal from read-only discovery. Nothing below has been created, approved, or reserved yet.')
  reporter.section('Observed in AWS (read-only, point in time)')
  reporter.facts([...imageFacts(proposal.image, proposal.pin), ...instanceFacts(proposal.instanceType)])
  reporter.section('Reviewed by Qiln (not verified on a host)')
  reporter.facts(reviewedFacts())
  reporter.space()
  reporter.info(
    'These are the reviewed repository expectations for the pinned image, not observed guest state. Qiln grants no instance profile and does not use SSM.',
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
    reporter.facts([...storageFacts(plan, proposal, target), ...accessFacts(plan)])
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

/**
 * States what approval starts. Counts and settings come from the frozen plan,
 * so this screen cannot describe a different launch than the record will govern.
 */
export function reportCreationEffects(reporter: Reporter, plan: HostPlan, reuse: Reuse | null): void {
  const { data } = plan
  const candidates = plan.hostSlots.length
  reporter.section('Creation approval')
  reporter.facts([
    ['Network', `one VPC ${plan.cidr} · one subnet in each of ${plan.zones.length} zones · internet gateway · route table · one security group`],
    ['Access key', `generate one local ${plan.key.algorithm} key and import its public half to AWS as a key pair`],
    [
      'Host',
      `launch ${plan.count} ${plan.instanceType} (${plan.purchase}) with the reviewed cloud-init user-data, trying ${candidates} approved ${candidates === 1 ? 'zone' : 'zones'} once each; the next zone is tried only after AWS definitively refuses capacity`,
    ],
    [
      'Storage',
      reuse === null
        ? `create and attach one ${data.sizeGiB} GiB data volume in the launched zone · ${termination(data.deleteOnTermination)}`
        : `attach existing data volume ${reuse.volumeId} from deployment ${reuse.from} · no new volume is created · ${termination(data.deleteOnTermination)}`,
    ],
    ['Public address', 'allocate and associate one Elastic IP'],
    ['Verification', 'each step is followed by an observation, then AWS instance health is read'],
  ])
  reporter.space()
  reporter.notice(
    'Approval creates billable AWS resources immediately. It is not spend protection and no cost estimate is shown. The data volume is retained by removal and keeps incurring charges until it is deleted outside Qiln.',
  )
  if (reuse !== null) {
    reporter.notice(
      `Approval also records that deployment ${reuse.from} hands ${reuse.volumeId} off to this one: its removal evidence is unchanged, but it stops reporting the volume. Qiln does not inspect or verify the volume's contents.`,
    )
  }
  reporter.notice(
    'Cancelling or a failure does not roll back. Completed and uncertain effects are retained as evidence and are never replayed automatically.',
  )
  reporter.notice(
    'Success means AWS provisioning and health verified. Create makes no SSH connection, so SSH access, host identity, guest compatibility, and readiness are not established.',
  )
}
