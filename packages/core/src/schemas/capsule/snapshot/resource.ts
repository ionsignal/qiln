import { z } from 'zod'
import { CapsuleBlueprintIdentifierSchema } from '../../blueprint/provision'

const IncusResourceIdentitySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Incus snapshot reference identities cannot contain control characters.',
  })

/**
 * Operation-scoped state for one planned managed-volume provider snapshot.
 *
 * These states describe Create Snapshot execution accounting. They are not
 * committed snapshot history and must never become branch-fork authority.
 */
export const CapsuleSnapshotCreateResourceStatus = {
  PLANNED: 'planned',
  CREATING: 'creating',
  CREATED: 'created',
  DELETING: 'deleting',
  DELETED: 'deleted',
  MISSING: 'missing',
  ERROR: 'error',
} as const

export type CapsuleSnapshotCreateResourceStatusValue =
  (typeof CapsuleSnapshotCreateResourceStatus)[keyof typeof CapsuleSnapshotCreateResourceStatus]

export const CapsuleSnapshotCreateResourceStatusValues = [
  CapsuleSnapshotCreateResourceStatus.PLANNED,
  CapsuleSnapshotCreateResourceStatus.CREATING,
  CapsuleSnapshotCreateResourceStatus.CREATED,
  CapsuleSnapshotCreateResourceStatus.DELETING,
  CapsuleSnapshotCreateResourceStatus.DELETED,
  CapsuleSnapshotCreateResourceStatus.MISSING,
  CapsuleSnapshotCreateResourceStatus.ERROR,
] as const

export const CapsuleSnapshotCreateResourceStatusSchema = z.enum(CapsuleSnapshotCreateResourceStatusValues)

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
 * Immutable physical Incus snapshot identity for one managed Blueprint volume.
 *
 * `sourceBranchResourceId` links this evidence to Qiln's durable branch
 * resource ledger. `createResourceId` identifies the exact successful Create
 * Snapshot provider mutation copied into committed snapshot history. Forks must
 * use this committed identity rather than rediscovering a source snapshot from
 * live provider inventory.
 */
export const CapsuleSnapshotIncusVolumeReferenceSchema = z
  .object({
    provider: z.literal(CapsuleSnapshotResourceProvider.INCUS),
    kind: z.literal(CapsuleSnapshotResourceKind.CUSTOM_VOLUME_SNAPSHOT),
    blueprintVolumeName: CapsuleBlueprintIdentifierSchema,
    sourceBranchResourceId: z.uuid(),
    createResourceId: z.uuid(),
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
