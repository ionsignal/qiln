import { z } from 'zod'
import { CapsuleRootfsImagePinSchema } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { ProvisioningFileTarget } from './bootstrap/targets'

const NonEmptyStringSchema = z.string().trim().min(1)

export const ProjectResourceMetadataSchema = z
  .object({
    namespace: NonEmptyStringSchema,
  })
  .strict()

export const InstanceResourceMetadataSchema = z
  .object({
    namespace: NonEmptyStringSchema,
    instanceName: NonEmptyStringSchema,
    rootfsImagePin: CapsuleRootfsImagePinSchema,
  })
  .strict()

export const VolumeResourceMetadataSchema = z
  .object({
    namespace: NonEmptyStringSchema,
    pool: NonEmptyStringSchema,
    volumeName: NonEmptyStringSchema,
    mountPath: NonEmptyStringSchema,
    sourceVolume: z.string().nullable(),
    volumeType: z.enum(['empty', 'clone']),
  })
  .strict()

export const BindMountResourceMetadataSchema = z
  .object({
    namespace: NonEmptyStringSchema,
    hostPath: NonEmptyStringSchema,
    mountPath: NonEmptyStringSchema,
    readonly: z.boolean(),
    shifted: z.boolean(),
  })
  .strict()

export const InstanceProvisioningFileResourceMetadataSchema = z
  .object({
    namespace: NonEmptyStringSchema,
    branchName: NonEmptyStringSchema,
    instanceName: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    target: z.literal('instance'),
  })
  .strict()

export const VolumeProvisioningFileResourceMetadataSchema = z
  .object({
    namespace: NonEmptyStringSchema,
    branchName: NonEmptyStringSchema,
    instanceName: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    target: z.literal('volume'),
    pool: NonEmptyStringSchema,
    volumeName: NonEmptyStringSchema,
    internalPath: NonEmptyStringSchema,
  })
  .strict()

export const ProvisioningFileResourceMetadataSchema = z.discriminatedUnion('target', [
  InstanceProvisioningFileResourceMetadataSchema,
  VolumeProvisioningFileResourceMetadataSchema,
])

export type ProjectResourceMetadata = z.infer<typeof ProjectResourceMetadataSchema>
export type InstanceResourceMetadata = z.infer<typeof InstanceResourceMetadataSchema>
export type VolumeResourceMetadata = z.infer<typeof VolumeResourceMetadataSchema>
export type BindMountResourceMetadata = z.infer<typeof BindMountResourceMetadataSchema>
export type ProvisioningFileResourceMetadata = z.infer<typeof ProvisioningFileResourceMetadataSchema>

function parseResourceMetadata<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  context: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new IncusError(`Invalid ${context}.`, 'VALIDATION_ERROR', z.treeifyError(parsed.error))
  }
  return parsed.data
}

export function parseProjectResourceMetadata(value: unknown): ProjectResourceMetadata {
  return parseResourceMetadata(ProjectResourceMetadataSchema, value, 'capsule branch project resource metadata')
}

export function parseInstanceResourceMetadata(value: unknown): InstanceResourceMetadata {
  return parseResourceMetadata(InstanceResourceMetadataSchema, value, 'capsule branch instance resource metadata')
}

export function parseVolumeResourceMetadata(value: unknown): VolumeResourceMetadata {
  return parseResourceMetadata(VolumeResourceMetadataSchema, value, 'capsule branch volume resource metadata')
}

export function parseBindMountResourceMetadata(value: unknown): BindMountResourceMetadata {
  return parseResourceMetadata(BindMountResourceMetadataSchema, value, 'capsule branch bind mount resource metadata')
}

export function parseProvisioningFileResourceMetadata(value: unknown): ProvisioningFileResourceMetadata {
  return parseResourceMetadata(
    ProvisioningFileResourceMetadataSchema,
    value,
    'capsule branch provisioning file resource metadata',
  )
}

export function createProvisioningFileResourceMetadata(
  namespace: string,
  branchName: string,
  instanceName: string,
  filePath: string,
  target: ProvisioningFileTarget,
): ProvisioningFileResourceMetadata {
  if (target.target === 'volume') {
    return ProvisioningFileResourceMetadataSchema.parse({
      namespace,
      branchName,
      instanceName,
      path: filePath,
      target: 'volume',
      pool: target.pool,
      volumeName: target.volumeName,
      internalPath: target.internalPath,
    })
  }
  return ProvisioningFileResourceMetadataSchema.parse({
    namespace,
    branchName,
    instanceName,
    path: filePath,
    target: 'instance',
  })
}
