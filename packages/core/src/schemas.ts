import { z } from 'zod'
import { GlobalErrorCode } from './errors'

export const GlobalErrorCodeSchema = z.enum(GlobalErrorCode)

/**
 * Request: System Ping
 */
export const SystemPingRequestSchema = z
  .object({
    timestamp: z.number().optional(),
  })
  .strict()

/**
 * Response: System Ping
 */
export const SystemPingResponseSchema = z
  .object({
    target: z.string(),
    domain: z.string(),
    action: z.string(),
    receivedTimestamp: z.number().optional(),
    serverTimestamp: z.number(),
  })
  .strict()

export type SystemPingResponse = z.infer<typeof SystemPingResponseSchema>
export type SystemPingRequest = z.infer<typeof SystemPingRequestSchema>

// Envelope shape for global rpc responses
export type GlobalRpcResponse<T = unknown> = { success: true; data: T } | { success: false; error: GlobalErrorCode; details?: any }

/**
 * Static Transport Envelope Validation for Global RPC.
 * Decouples Transport-level parsing from Domain-level parsing.
 */
export const BaseGlobalRpcResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    success: z.literal(false),
    error: GlobalErrorCodeSchema,
    details: z.unknown().optional(),
  }),
])
