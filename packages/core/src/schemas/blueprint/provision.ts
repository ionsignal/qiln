import { z } from 'zod'
import { isCanonicalAbsolutePosixPath } from '../posix'

export const CapsuleBlueprintConfigMapSchema = z.record(z.string(), z.string())

export const CapsuleBlueprintIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,98}[a-zA-Z0-9])?$/,
    'Blueprint identifiers must be alphanumeric and may contain internal hyphens or underscores.',
  )

export const CapsuleBlueprintAbsolutePathSchema = z.string().refine(isCanonicalAbsolutePosixPath, {
  message: 'Blueprint paths must be canonical absolute POSIX paths.',
})

/**
 * A narrow runtime device passthrough.
 *
 * Qiln validates only the shape current capsule blueprints require rather than
 * making Core a complete Incus API schema package.
 */
export const CapsuleBlueprintDeviceSchema = z
  .object({
    type: z.string(),
  })
  .catchall(z.string())

export const CapsuleBlueprintDeviceMapSchema = z.record(z.string(), CapsuleBlueprintDeviceSchema)

export const CapsuleBlueprintVolumeTypeSchema = z.enum(['clone', 'empty', 'bind'])

export const CapsuleBlueprintBaseVolumeSchema = z.object({
  name: CapsuleBlueprintIdentifierSchema,
  mount_path: CapsuleBlueprintAbsolutePathSchema,
  readonly: z.boolean().default(false),
  shifted: z.boolean().default(true),
})

export const CapsuleBlueprintCloneVolumeSchema = CapsuleBlueprintBaseVolumeSchema.extend({
  type: z.literal('clone'),
  pool: z.string().trim().min(1),
  source_volume: z.string().trim().min(1),
}).strict()

export const CapsuleBlueprintEmptyVolumeSchema = CapsuleBlueprintBaseVolumeSchema.extend({
  type: z.literal('empty'),
  pool: z.string().trim().min(1),
}).strict()

export const CapsuleBlueprintBindMountVolumeSchema = CapsuleBlueprintBaseVolumeSchema.extend({
  type: z.literal('bind'),
  host_path: CapsuleBlueprintAbsolutePathSchema,
}).strict()

export const CapsuleBlueprintVolumeDefinitionSchema = z.discriminatedUnion('type', [
  CapsuleBlueprintCloneVolumeSchema,
  CapsuleBlueprintEmptyVolumeSchema,
  CapsuleBlueprintBindMountVolumeSchema,
])

/**
 * V1 capsule artifacts support regular files and directories only.
 *
 * Blueprint-defined symlinks are rejected at this policy boundary. A future
 * collector must independently use `lstat`, must not follow symlinks, and must
 * fail capture when it encounters an unsupported filesystem entry.
 */
export const CapsuleBlueprintFileDefinitionSchema = z
  .object({
    path: CapsuleBlueprintAbsolutePathSchema,
    type: z.enum(['file', 'directory']).default('file'),
    uid: z.number().int().nonnegative().default(1000),
    gid: z.number().int().nonnegative().default(1000),
    mode: z
      .string()
      .regex(/^[0-7]{4}$/, 'Blueprint file modes must contain exactly four octal digits.')
      .default('0644'),
    content: z.string().optional(),
  })
  .strict()
  .superRefine((file, context) => {
    if (file.type === 'directory' && file.content !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Blueprint directory definitions cannot contain file content.',
      })
    }
  })

export const CapsuleBlueprintRuntimeSchema = z
  .object({
    config: CapsuleBlueprintConfigMapSchema.default({}),
    devices: CapsuleBlueprintDeviceMapSchema.default({}),
  })
  .strict()

export type CapsuleBlueprintConfigMap = z.infer<typeof CapsuleBlueprintConfigMapSchema>
export type CapsuleBlueprintIdentifier = z.infer<typeof CapsuleBlueprintIdentifierSchema>
export type CapsuleBlueprintDevice = z.infer<typeof CapsuleBlueprintDeviceSchema>
export type CapsuleBlueprintDeviceMap = z.infer<typeof CapsuleBlueprintDeviceMapSchema>
export type CapsuleBlueprintVolumeType = z.infer<typeof CapsuleBlueprintVolumeTypeSchema>
export type CapsuleBlueprintCloneVolume = z.infer<typeof CapsuleBlueprintCloneVolumeSchema>
export type CapsuleBlueprintEmptyVolume = z.infer<typeof CapsuleBlueprintEmptyVolumeSchema>
export type CapsuleBlueprintBindMountVolume = z.infer<typeof CapsuleBlueprintBindMountVolumeSchema>
export type CapsuleBlueprintVolumeDefinition = z.infer<typeof CapsuleBlueprintVolumeDefinitionSchema>
export type CapsuleBlueprintFileDefinition = z.infer<typeof CapsuleBlueprintFileDefinitionSchema>
export type CapsuleBlueprintRuntime = z.infer<typeof CapsuleBlueprintRuntimeSchema>
