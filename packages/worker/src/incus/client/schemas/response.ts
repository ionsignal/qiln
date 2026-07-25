import { z } from 'zod'

/**
 * Incus uses a universal envelope for all API responses. We use a discriminated
 * union to strictly handle errors even when HTTP 200 is returned.
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

export const IncusEventSchema = z.object({
  timestamp: z.string(),
  type: z.literal('operation'),
  metadata: IncusOperationSchema,
})

/**
 * Incus operation status codes that conclusively represent a terminal provider
 * outcome. Nonterminal statuses remain pending and continue through event
 * observation or HTTP reconciliation.
 */
export const INCUS_FINAL: ReadonlySet<number> = new Set([200, 400, 401])

export type IncusResponse = z.infer<typeof IncusResponseSchema>
export type IncusOperation = z.infer<typeof IncusOperationSchema>
export type IncusEvent = z.infer<typeof IncusEventSchema>
