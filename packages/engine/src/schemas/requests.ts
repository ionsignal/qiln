import { z } from 'zod'

/**
 * RPC: System Ping Request
 * Used to verify end-to-end NATS connectivity and Queue Group routing.
 */
export const SystemPingRequestSchema = z
  .object({
    timestamp: z.number().optional(),
  })
  .strict()

export type SystemPingRequest = z.infer<typeof SystemPingRequestSchema>
