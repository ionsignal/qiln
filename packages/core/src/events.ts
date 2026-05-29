import { z } from 'zod'

export const GlobalEventType = {
  SYSTEM_MAINTENANCE: 'system.maintenance',
} as const

export const SystemMaintenancePayloadSchema = z
  .object({
    type: z.literal(GlobalEventType.SYSTEM_MAINTENANCE),
    active: z.boolean(),
  })
  .strict()

export type GlobalEvent = z.infer<typeof SystemMaintenancePayloadSchema>
