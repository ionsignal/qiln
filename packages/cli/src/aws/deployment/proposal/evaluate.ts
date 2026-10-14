import type { ImagePin } from '../../ami'
import { AWS_SPEC } from '../../spec'
import { planOf } from '../host/plan'
import { allocate } from '../topology'
import { storageOf } from './storage'
import type { Discovery, Finding, HostProposal, ImageEvidence, InstanceTypeEvidence } from './types'

const { compute, deployment } = AWS_SPEC

type Requirement = readonly [passed: boolean, message: string]

export interface Inputs {
  region: string
  administrator: string
  pin: ImagePin
}

function hasBlocker(findings: readonly Finding[]): boolean {
  return findings.some(finding => finding.severity === 'blocker')
}

export function isBlocked(proposal: HostProposal): boolean {
  return hasBlocker(proposal.findings)
}

function blockers(requirements: readonly Requirement[]): Finding[] {
  return requirements.flatMap(([passed, message]): Finding[] => (passed ? [] : [{ severity: 'blocker', message }]))
}

/**
 * An omitted AMI boot mode has the documented x86 default, legacy BIOS.
 * uefi-preferred selects UEFI when the instance supports it and otherwise
 * legacy BIOS. Any other value must be a mode the instance lists, and an
 * unrecognized value never passes. A missing instance type is reported by its
 * own finding.
 */
function bootable(bootMode: string | null, instance: InstanceTypeEvidence | null): boolean {
  if (instance === null) {
    return true
  }
  const modes = instance.bootModes
  switch (bootMode) {
    case null:
      return modes.includes('legacy-bios')
    case 'uefi-preferred':
      return modes.includes('uefi') || modes.includes('legacy-bios')
    case 'uefi':
    case 'legacy-bios':
      return modes.includes(bootMode)
    default:
      return false
  }
}

/**
 * The pin selects identity and live inspection establishes current metadata,
 * so the returned ID and numeric owner must both equal the reviewed entry.
 * The AMI hypervisor field is deliberately not compared: image metadata uses
 * xen or ovm, while instance metadata uses nitro or xen.
 */
function imageFindings(
  image: ImageEvidence,
  pin: ImagePin,
  instance: InstanceTypeEvidence | null,
  discoveredAt: string,
): Finding[] {
  const findings = blockers([
    [image.id === pin.imageId, 'The returned image is not the reviewed AMI.'],
    [image.ownerId === pin.ownerId, 'The image owner is not the reviewed publisher account.'],
    [image.name === compute.image.name, 'The image name does not match the reviewed release.'],
    [image.architecture === compute.image.architecture, 'The image architecture is not x86_64.'],
    [image.state === 'available', 'The image is not in the available state.'],
    [image.imageType === 'machine', 'The image is not a machine image.'],
    [image.rootDeviceType === 'ebs', 'The image does not use an EBS root device.'],
    [image.virtualizationType === 'hvm', 'The image does not use HVM virtualization.'],
    [image.enaSupport === true, 'The image does not advertise ENA support.'],
    [bootable(image.bootMode, instance), 'The image boot mode is not supported by the instance type.'],
  ])
  if (image.deprecationTime !== null) {
    findings.push({
      severity: image.deprecationTime <= discoveredAt ? 'blocker' : 'review',
      message: `The image has a deprecation time of ${image.deprecationTime}.`,
    })
  }
  if (image.productCodes.length > 0) {
    findings.push({ severity: 'review', message: 'The image carries product codes, which can add licensing charges.' })
  }
  return findings
}

function instanceFindings(instance: InstanceTypeEvidence | null): Finding[] {
  if (instance === null) {
    return [{ severity: 'blocker', message: `${compute.instanceType} was not returned for this region.` }]
  }
  return blockers([
    [instance.name === compute.instanceType, 'The returned instance type is not the requested type.'],
    [instance.architectures.includes('x86_64'), 'The instance type does not support x86_64.'],
    [instance.usageClasses.includes('on-demand'), 'The instance type does not support On-Demand usage.'],
    [instance.rootDeviceTypes.includes('ebs'), 'The instance type does not support an EBS root device.'],
    [instance.virtualizationTypes.includes('hvm'), 'The instance type does not support HVM.'],
    [
      instance.enaSupport === 'supported' || instance.enaSupport === 'required',
      'The instance type does not explicitly report ENA support.',
    ],
    [instance.gpus.some(gpu => gpu.manufacturer === 'NVIDIA'), 'The instance type reports no NVIDIA GPU.'],
  ])
}

/**
 * Pure judgement of one discovery. Discovery validation only establishes
 * shape, so compatibility and cross-field consistency are judged here, and
 * missing evidence never passes. The reviewed pin alone selects the image; a
 * newer release is never substituted. Subnets cover every available standard
 * zone, and the host zone is the lowest zone ID that is both available and
 * offered. The frozen plan exists only when nothing blocks.
 */
export function evaluate(discovery: Discovery, inputs: Inputs): HostProposal {
  const { image } = discovery
  const available = discovery.zones.filter(zone => zone.state === 'available')
  const hostZone =
    allocate(deployment.defaultCidr, available).find(zone => discovery.offeredZoneIds.includes(zone.id)) ?? null
  const { root, instanceStore, findings: storageFindings } = storageOf(image)
  const findings: Finding[] = [
    ...(image === null
      ? [
          {
            severity: 'blocker' as const,
            message: `The reviewed AMI ${inputs.pin.imageId} was not returned for this account and region. This does not prove that it does not exist.`,
          },
        ]
      : imageFindings(image, inputs.pin, discovery.instanceType, discovery.discoveredAt)),
    ...instanceFindings(discovery.instanceType),
    ...blockers([
      [
        new Set(discovery.zones.map(zone => zone.id)).size === discovery.zones.length,
        'Availability Zone IDs are not unique.',
      ],
      [available.length > 0, 'No standard Availability Zone reports available.'],
      [available.length <= deployment.maximumZones, `More than ${deployment.maximumZones} standard Availability Zones are available.`],
      [hostZone !== null, `${compute.instanceType} is not offered in any available standard Availability Zone.`],
    ]),
    ...storageFindings,
  ]
  const plan =
    hasBlocker(findings) || hostZone === null || root === null
      ? null
      : planOf({
          region: inputs.region,
          pin: inputs.pin,
          administrator: inputs.administrator,
          zones: available,
          hostZoneId: hostZone.id,
          root,
        })
  return {
    region: inputs.region,
    pin: inputs.pin,
    discoveredAt: discovery.discoveredAt,
    image,
    instanceType: discovery.instanceType,
    excludedZones: discovery.zones.filter(zone => zone.state !== 'available'),
    instanceStore,
    plan,
    findings,
  }
}
