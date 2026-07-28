import { z } from 'zod'
import { CapsuleRootfsImageFingerprintSchema, CapsuleRootfsImageProjectSchema } from '@qiln/core/server'

export const IncusInstanceSchema = z.object({
  name: z.string(),
  status: z.string(),
  status_code: z.number(),
})

export const IncusDeviceSchema = z
  .object({
    type: z.string(),
  })
  .catchall(z.string())

export const IncusDeviceMapSchema = z.record(z.string(), IncusDeviceSchema)

export const IncusInstanceImageAliasSourceSchema = z
  .object({
    type: z.literal('image'),
    alias: z.string(),
  })
  .strict()

/**
 * Exact rootfs source used when reconstructing a branch from durable capsule
 * history. Fingerprint and source project are both required so Incus cannot
 * resolve a mutable alias during fork execution.
 */
export const IncusInstanceImageFingerprintSourceSchema = z
  .object({
    type: z.literal('image'),
    fingerprint: CapsuleRootfsImageFingerprintSchema,
    project: CapsuleRootfsImageProjectSchema,
  })
  .strict()

export const IncusInstanceSourceSchema = z.union([
  IncusInstanceImageAliasSourceSchema,
  IncusInstanceImageFingerprintSourceSchema,
])

export const IncusInstanceCreatePayloadSchema = z
  .object({
    name: z.string(),
    source: IncusInstanceSourceSchema,
    config: z.record(z.string(), z.string()).optional(),
    devices: IncusDeviceMapSchema.optional(),
  })
  .strict()

export const IncusInstancePutSchema = z.object({
  architecture: z.string().optional(),
  config: z.record(z.string(), z.string()).optional(),
  devices: IncusDeviceMapSchema.optional(),
  ephemeral: z.boolean().optional(),
  profiles: z.array(z.string()).optional(),
  restore: z.string().optional(),
  stateful: z.boolean().optional(),
  description: z.string().optional(),
})

export const IncusInstanceFullSchema = IncusInstancePutSchema.extend({
  name: z.string(),
  status: z.string(),
  status_code: z.number(),
}).loose()

export type IncusInstance = z.infer<typeof IncusInstanceSchema>
export type IncusDeviceMap = z.infer<typeof IncusDeviceMapSchema>
export type IncusInstanceImageAliasSource = z.infer<typeof IncusInstanceImageAliasSourceSchema>
export type IncusInstanceImageFingerprintSource = z.infer<typeof IncusInstanceImageFingerprintSourceSchema>
export type IncusInstanceSource = z.infer<typeof IncusInstanceSourceSchema>
export type IncusInstanceCreatePayload = z.infer<typeof IncusInstanceCreatePayloadSchema>
export type IncusInstancePut = z.infer<typeof IncusInstancePutSchema>
export type IncusInstanceFull = z.infer<typeof IncusInstanceFullSchema>
