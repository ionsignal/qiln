import { z } from 'zod'
import { imagePinSchema, isSnapshotId } from '../../ami'
import { count, positive, text } from '../../primitives'
import { regionSchema } from '../../types'
import { validCidr } from '../cidr'
import { bootstrapSchema } from './bootstrap'

/**
 * Literals of the record version, not reads of today's spec. Generation always
 * uses an empty passphrase, and the protection text never implies encryption.
 */
const KEY_PASSPHRASE = 'none'
const KEY_PROTECTION = 'owner-only directory 0700, file 0600'

const rootSourceFields = {
  deviceName: text,
  snapshotId: z.string().refine(isSnapshotId, 'Expected a snapshot ID.'),
}

const volumeFields = {
  volumeType: text,
  sizeGiB: positive,
  iops: positive,
  throughput: positive,
  deleteOnTermination: z.boolean(),
}

const rootSourceSchema = z.strictObject(rootSourceFields)

const rootVolumeSchema = z.strictObject({
  ...rootSourceFields,
  ...volumeFields,
})

/**
 * `deleteOnTermination` is an expectation, not a request field: the volume is
 * created and attached separately, so retention is verified after attach.
 */
const dataVolumeSchema = z.strictObject({
  deviceName: text,
  ...volumeFields,
})

const primaryInterfaceSchema = z.strictObject({
  deviceIndex: count,
  networkCardIndex: count,
  associatePublicIp: z.boolean(),
  deleteOnTermination: z.boolean(),
})

const metadataSchema = z.strictObject({
  httpEndpoint: text,
  httpTokens: text,
  httpPutResponseHopLimit: positive,
  httpProtocolIpv6: text,
  instanceMetadataTags: text,
})

const keyPolicySchema = z.strictObject({
  algorithm: text,
  passphrase: z.string().refine(value => value === KEY_PASSPHRASE, 'Expected no passphrase.'),
  protection: z.string().refine(value => value === KEY_PROTECTION, 'Expected owner-only key protection.'),
})

const elasticIpSchema = z.strictObject({
  allowReassociation: z.boolean(),
})

/**
 * Zones and ingress rules are judged loosely here. The deployment approval
 * judges them strictly and requires them to equal the plan's own.
 */
const hostZoneSchema = z.strictObject({
  id: text,
  name: text,
  cidr: text,
})

const hostIngressSchema = z.strictObject({
  port: z.int().min(1).max(65_535),
  cidr: text,
})

/**
 * Strictly ascending, so the order is the zone ID order that the zones keep.
 */
function isAscendingWithin(slots: readonly number[], zoneCount: number): boolean {
  return slots.every((slot, index) => slot < zoneCount && (index === 0 || slot > slots[index - 1]))
}

/**
 * Shape, bounds, internal consistency, and the lifecycle invariants that every
 * deployment must keep: one instance, root volume and primary interface deleted
 * with it, a data volume retained on its own device name, an Ed25519
 * administrative key without a passphrase, and the exact approved bootstrap.
 * These are literals of the record version, not today's compute constants, so
 * a stored plan keeps its meaning when they change. Zone and ingress semantics
 * are judged by the approval schema, which requires them to equal its own.
 */
export const hostPlanSchema = z
  .strictObject({
    region: regionSchema,
    pin: imagePinSchema,
    instanceType: text,
    count: positive,
    purchase: text,
    cidr: z.string().refine(validCidr, 'Expected a private network CIDR.'),
    zones: z.array(hostZoneSchema).min(1),
    hostSlots: z.array(count).min(1),
    ingress: z.array(hostIngressSchema).min(1),
    root: rootVolumeSchema,
    data: dataVolumeSchema,
    network: primaryInterfaceSchema,
    metadata: metadataSchema,
    key: keyPolicySchema,
    bootstrap: bootstrapSchema,
    elasticIp: elasticIpSchema,
    tagged: z.array(text),
  })
  .refine(({ hostSlots, zones }) => isAscendingWithin(hostSlots, zones.length), 'Expected ascending launch slots within the zones.')
  .refine(
    plan =>
      plan.count === 1 &&
      plan.root.deleteOnTermination &&
      plan.network.deleteOnTermination &&
      !plan.data.deleteOnTermination &&
      plan.root.deviceName !== plan.data.deviceName &&
      plan.key.algorithm === 'ed25519',
    'Expected one host with a retained data volume and an Ed25519 key.',
  )

/**
 * The complete launch configuration, frozen from reviewed evidence. The launch
 * candidates are slots into `zones`, in ascending zone ID order, and each is
 * tried once. They are never changed or replaced by another zone.
 * There is deliberately no instance profile. The bootstrap is the exact
 * cloud-init user-data the launch sends. Qiln-normalized shapes only: the
 * provider mapping belongs to `ec2/`.
 */
export type HostPlan = z.infer<typeof hostPlanSchema>
export type RootSource = z.infer<typeof rootSourceSchema>
export type RootVolume = z.infer<typeof rootVolumeSchema>
export type DataVolume = z.infer<typeof dataVolumeSchema>
export type PrimaryInterface = z.infer<typeof primaryInterfaceSchema>
export type Metadata = z.infer<typeof metadataSchema>
export type KeyPolicy = z.infer<typeof keyPolicySchema>
export type ElasticIp = z.infer<typeof elasticIpSchema>
