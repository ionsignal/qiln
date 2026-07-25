import { z } from 'zod'

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

export const IncusInstanceSourceSchema = z
  .object({
    type: z.literal('image'),
    alias: z.string(),
  })
  .strict()

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
export type IncusInstanceCreatePayload = z.infer<typeof IncusInstanceCreatePayloadSchema>
export type IncusInstancePut = z.infer<typeof IncusInstancePutSchema>
export type IncusInstanceFull = z.infer<typeof IncusInstanceFullSchema>
