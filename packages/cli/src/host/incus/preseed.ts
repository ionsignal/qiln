import { z } from 'zod'
import { parse, stringify } from 'yaml'
import { INCUS_SPEC } from './spec'
import { sha256Of } from './recipe'
import { datasetNamesOf } from '../zfs/spec'

const settings = z.record(z.string(), z.string())

/**
 * One ZFS pool and one managed bridge, in Incus API form. Server config and
 * profiles are deliberately absent, so no remote listener is set and the
 * pristine default profile is untouched. The installation attaches its instance
 * to the pool and the bridge explicitly.
 */
const preseedSchema = z.strictObject({
  storage_pools: z.tuple([z.strictObject({ name: z.string(), driver: z.literal('zfs'), config: settings })]),
  networks: z.tuple([
    z.strictObject({ name: z.string(), project: z.literal('default'), type: z.literal('bridge'), config: settings }),
  ]),
})

export type PreseedDocument = z.infer<typeof preseedSchema>

/**
 * The exact approved bytes, their digest, and the structure they express.
 */
export interface Preseed {
  yaml: string
  sha256: string
  document: PreseedDocument
}

/**
 * Serialized once, so the approved bytes are the bytes that run. The Incus pool
 * is named like the zpool but sourced only from the `incus` dataset, which keeps
 * the state dataset outside the driver's control. `zfs.export` stays false so
 * stopping Incus leaves the pool imported for the separate approved export.
 * `source.wipe` is never set.
 */
export function preseedOf(pool: string): Preseed {
  const { network } = INCUS_SPEC
  const dataset = datasetNamesOf(pool).incus
  const document = preseedSchema.parse({
    storage_pools: [
      {
        name: pool,
        driver: 'zfs',
        config: { source: dataset, 'zfs.pool_name': dataset, 'zfs.export': 'false' },
      },
    ],
    networks: [
      {
        name: network.name,
        project: 'default',
        type: 'bridge',
        config: {
          'ipv4.address': network.address,
          'ipv4.nat': 'true',
          'ipv4.dhcp': 'true',
          'ipv4.dhcp.ranges': network.dhcpRange,
          'ipv4.routing': 'true',
          'ipv4.firewall': 'true',
          'ipv6.address': 'none',
        },
      },
    ],
  })
  const yaml = stringify(document)
  return { yaml, sha256: sha256Of(yaml), document }
}

/**
 * Reads the expected state back from retained preseed bytes. Null means the
 * bytes are not a preseed that Qiln would have produced.
 */
export function readPreseed(text: string): PreseedDocument | null {
  try {
    const value: unknown = parse(text)
    const parsed = preseedSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
