import { z } from 'zod'
import { HostEventType } from './constants'

/**
 * Notify: Incus Instance State Change
 */
export const InstanceStatePayloadSchema = z
  .object({
    type: z.literal(HostEventType.INSTANCE_STATE),
    ownerId: z.uuid(),
    instance: z.string(),
    status: z.enum(['provisioning', 'offline', 'starting', 'online', 'stopping', 'archived', 'error']),
  })
  .strict()

/**
 * Notify: Incus Instance Deleted
 */
export const InstanceDeletedPayloadSchema = z
  .object({
    type: z.literal(HostEventType.INSTANCE_DELETED),
    ownerId: z.uuid(),
    instance: z.string(),
  })
  .strict()

export const HostEventSchemaMap = {
  [HostEventType.INSTANCE_STATE]: InstanceStatePayloadSchema,
  [HostEventType.INSTANCE_DELETED]: InstanceDeletedPayloadSchema,
} as const

/**
 * Type guard to check if a generic string is a valid HostEventType.
 * Provides O(1) performance using the native `in` operator.
 */
export function isHostEventType(type: string): type is HostEventType {
  return type in HostEventSchemaMap
}

/**
 * Union: Any valid event emitted by the Host Infrastructure.
 */
export const HostEventSchema = z.discriminatedUnion('type', [InstanceStatePayloadSchema, InstanceDeletedPayloadSchema])

export type HostEvent = z.infer<typeof HostEventSchema>
export type InstanceStatePayload = z.infer<typeof InstanceStatePayloadSchema>
export type InstanceDeletedPayload = z.infer<typeof InstanceDeletedPayloadSchema>

// Envelope shape for rpc responses
export type RpcResponse<T = unknown> = { success: true; data: T } | { success: false; error: string; details?: any }

/**
 * Static Transport Envelope Validation for Internal RPC.
 * Decouples Transport-level parsing from Domain-level parsing.
 */
export const BaseRpcResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    details: z.unknown().optional(),
  }),
])
