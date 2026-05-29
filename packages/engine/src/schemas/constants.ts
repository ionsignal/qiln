import { z } from 'zod'

export const HostEventType = {
  INSTANCE_STATE: 'instance.state',
  INSTANCE_DELETED: 'instance.deleted',
} as const

export const HostEventTypeSchema = z.enum([HostEventType.INSTANCE_STATE, HostEventType.INSTANCE_DELETED])

export type HostEventType = z.infer<typeof HostEventTypeSchema>
