import { z } from 'zod'

/**
 * Incus uses a universal envelope for all API responses.
 * We use a discriminated union to strictly handle errors even when HTTP 200 is returned.
 */
export const IncusResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sync'),
    status: z.string(),
    status_code: z.number(),
    metadata: z.unknown(),
  }),
  z.object({
    type: z.literal('async'),
    status: z.string(),
    status_code: z.number(),
    operation: z.string(),
    metadata: z.object({
      id: z.string(),
      status: z.string(),
      status_code: z.number(),
    }),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    error_code: z.number(),
  }),
])

/**
 * Schema for the metadata returned by an async Operation wait.
 */
export const IncusOperationSchema = z.object({
  id: z.string(),
  class: z.string(),
  description: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.string(),
  status_code: z.number(),
  err: z.string().optional(),
})

/**
 * Schema for network addresses
 */
export const IncusAddressSchema = z.object({
  family: z.string(),
  address: z.string(),
  netmask: z.string(),
  scope: z.string(),
})

/**
 * Schema for network interfaces
 */
export const IncusNetworkInterfaceSchema = z.object({
  state: z.string(),
  type: z.string(),
  addresses: z.array(IncusAddressSchema).optional(),
})

/**
 * Schema for an Instance's state (Network, CPU, Status).
 */
export const IncusStateSchema = z.object({
  status: z.string(),
  status_code: z.number(),
  network: z.record(z.string(), IncusNetworkInterfaceSchema).optional(),
})

/**
 * Schema for an Instance definition (from recursion=1)
 */
export const IncusInstanceSchema = z.object({
  name: z.string(),
  status: z.string(),
  status_code: z.number(),
})

/**
 * Schema for messages received over the /1.0/events WebSocket
 */
export const IncusEventSchema = z.object({
  timestamp: z.string(),
  type: z.literal('operation'),
  metadata: IncusOperationSchema,
})

/**
 * Schemas for strict Incus Storage API payloads
 */
export const IncusVolumeConfigSchema = z.record(z.string(), z.string())

export const IncusVolumeSourceSchema = z
  .object({
    name: z.string(),
    type: z.literal('copy'),
    pool: z.string(),
    volume_only: z.boolean().optional(),
    project: z.string().optional(),
  })
  .strict()

export const IncusVolumeCreatePayloadSchema = z
  .object({
    name: z.string(),
    type: z.literal('custom'),
    content_type: z.literal('filesystem').optional(),
    config: IncusVolumeConfigSchema.optional(),
  })
  .strict()

export const IncusVolumeClonePayloadSchema = z
  .object({
    name: z.string(),
    type: z.literal('custom'),
    source: IncusVolumeSourceSchema,
    config: IncusVolumeConfigSchema.optional(),
  })
  .strict()

// Strict schema enforcing the required 'type' key for all Incus devices
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

export const IncusProjectSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    config: z.record(z.string(), z.string()).optional(),
  })
  .loose()

export const IncusProjectCreatePayloadSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    config: z.record(z.string(), z.string()).optional(),
  })
  .strict()

// Incus operation status codes:
// 200 = Success, 400 = Failure, 401 = Cancelled.
export const INCUS_FINAL: ReadonlySet<number> = new Set([200, 400, 401])

export type IncusResponse = z.infer<typeof IncusResponseSchema>
export type IncusOperation = z.infer<typeof IncusOperationSchema>
export type IncusState = z.infer<typeof IncusStateSchema>
export type IncusInstance = z.infer<typeof IncusInstanceSchema>
export type IncusEvent = z.infer<typeof IncusEventSchema>
export type IncusAddress = z.infer<typeof IncusAddressSchema>
export type IncusNetworkInterface = z.infer<typeof IncusNetworkInterfaceSchema>
export type IncusVolumeCreatePayload = z.infer<typeof IncusVolumeCreatePayloadSchema>
export type IncusVolumeClonePayload = z.infer<typeof IncusVolumeClonePayloadSchema>
export type IncusDeviceMap = z.infer<typeof IncusDeviceMapSchema>
export type IncusProject = z.infer<typeof IncusProjectSchema>
export type IncusProjectCreatePayload = z.infer<typeof IncusProjectCreatePayloadSchema>
export type IncusInstanceCreatePayload = z.infer<typeof IncusInstanceCreatePayloadSchema>
export type IncusInstancePut = z.infer<typeof IncusInstancePutSchema>
export type IncusInstanceFull = z.infer<typeof IncusInstanceFullSchema>
