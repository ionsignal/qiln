import { z } from 'zod'

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

export type IncusProject = z.infer<typeof IncusProjectSchema>
export type IncusProjectCreatePayload = z.infer<typeof IncusProjectCreatePayloadSchema>
