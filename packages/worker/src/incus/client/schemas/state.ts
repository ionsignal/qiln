import { z } from 'zod'

export const IncusAddressSchema = z.object({
  family: z.string(),
  address: z.string(),
  netmask: z.string(),
  scope: z.string(),
})

export const IncusNetworkInterfaceSchema = z.object({
  state: z.string(),
  type: z.string(),
  addresses: z.array(IncusAddressSchema).optional(),
})

const IncusNetworkSchema = z.preprocess(
  value => (value === null ? undefined : value),
  z.record(z.string(), IncusNetworkInterfaceSchema).optional(),
)

export const IncusStateSchema = z.object({
  status: z.string(),
  status_code: z.number(),
  network: IncusNetworkSchema,
})

export type IncusAddress = z.infer<typeof IncusAddressSchema>
export type IncusNetworkInterface = z.infer<typeof IncusNetworkInterfaceSchema>
export type IncusState = z.infer<typeof IncusStateSchema>
