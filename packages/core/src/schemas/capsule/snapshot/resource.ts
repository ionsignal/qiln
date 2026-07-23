import { z } from 'zod'
import { CapsuleBlueprintIdentifierSchema } from '../../blueprint/provision'
import { CapsuleArtifactRootIdSchema } from '../artifact/entry'

const IncusResourceIdentitySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Incus snapshot reference identities cannot contain control characters.',
  })

export const CapsuleSnapshotResourceProvider = {
  INCUS: 'incus',
} as const

export type CapsuleSnapshotResourceProvider =
  (typeof CapsuleSnapshotResourceProvider)[keyof typeof CapsuleSnapshotResourceProvider]

export const CapsuleSnapshotResourceProviderValues = [CapsuleSnapshotResourceProvider.INCUS] as const
export const CapsuleSnapshotResourceProviderSchema = z.enum(CapsuleSnapshotResourceProviderValues)

export const CapsuleSnapshotResourceKind = {
  CUSTOM_VOLUME_SNAPSHOT: 'custom_volume_snapshot',
} as const

export type CapsuleSnapshotResourceKind = (typeof CapsuleSnapshotResourceKind)[keyof typeof CapsuleSnapshotResourceKind]

export const CapsuleSnapshotResourceKindValues = [CapsuleSnapshotResourceKind.CUSTOM_VOLUME_SNAPSHOT] as const
export const CapsuleSnapshotResourceKindSchema = z.enum(CapsuleSnapshotResourceKindValues)

/**
 * Immutable physical Incus snapshot identity for one managed artifact root.
 *
 * `sourceBranchResourceId` links this evidence to Qiln's durable resource
 * ownership ledger. Future forks must use this committed identity rather than
 * rediscovering a source snapshot from live provider inventory.
 */
export const CapsuleSnapshotIncusVolumeReferenceSchema = z
  .object({
    provider: z.literal(CapsuleSnapshotResourceProvider.INCUS),
    kind: z.literal(CapsuleSnapshotResourceKind.CUSTOM_VOLUME_SNAPSHOT),
    artifactRootId: CapsuleArtifactRootIdSchema,
    blueprintVolumeName: CapsuleBlueprintIdentifierSchema,
    sourceBranchResourceId: z.uuid(),
    project: IncusResourceIdentitySchema,
    pool: IncusResourceIdentitySchema,
    sourceVolume: IncusResourceIdentitySchema,
    snapshotName: IncusResourceIdentitySchema,
  })
  .strict()

export const CapsuleSnapshotResourceReferenceSchema = z.discriminatedUnion('provider', [
  CapsuleSnapshotIncusVolumeReferenceSchema,
])

export type CapsuleSnapshotIncusVolumeReference = z.infer<typeof CapsuleSnapshotIncusVolumeReferenceSchema>
export type CapsuleSnapshotResourceReference = z.infer<typeof CapsuleSnapshotResourceReferenceSchema>
