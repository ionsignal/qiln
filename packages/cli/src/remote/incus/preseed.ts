import { z } from 'zod'
import { parse, stringify } from 'yaml'
import { INCUS_SPEC } from './spec'
import { InstallerError } from '../../diagnostic/error'
import { sha256Of } from './recipe'
import defaultProfile from '../../../../../catalog/profiles/qiln-default.yaml?raw'

const settings = z.record(z.string(), z.string())
const devices = z.record(z.string(), settings)

const profileSchema = z.strictObject({
  description: z.string(),
  config: settings,
  devices,
})

/**
 * The accepted preseed shape: one ZFS pool, one managed bridge, and the default
 * profile, in Incus API configuration form. Server config is deliberately
 * absent, so the remote API listener stays unset.
 */
const preseedSchema = z.strictObject({
  storage_pools: z.tuple([z.strictObject({ name: z.string(), driver: z.literal('zfs'), config: settings })]),
  networks: z.tuple([
    z.strictObject({ name: z.string(), project: z.literal('default'), type: z.literal('bridge'), config: settings }),
  ]),
  profiles: z.tuple([
    z.strictObject({
      name: z.literal('default'),
      project: z.literal('default'),
      description: z.string(),
      config: settings,
      devices,
    }),
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
 * The catalog profile and the pool name are repository and evidence inputs, so
 * a mismatch is a defect and not an operator-correctable input.
 */
function defect(): never {
  throw new InstallerError({
    code: 'INTERNAL_ERROR',
  })
}

/**
 * Builds the preseed once from the catalog default profile and Qiln-owned
 * constants. The result is serialized once, so the approved bytes are the bytes
 * that run. `zfs.export` stays false so that stopping Incus leaves the pool
 * imported for the separate, approved ZFS export. Never sets `source.wipe`.
 */
export function preseedOf(pool: string): Preseed {
  let profile: z.infer<typeof profileSchema>
  try {
    const value: unknown = parse(defaultProfile)
    profile = profileSchema.parse(value)
  } catch {
    return defect()
  }
  if (profile.devices.root?.pool !== pool) {
    return defect()
  }
  const { network } = INCUS_SPEC
  const document = preseedSchema.parse({
    storage_pools: [
      {
        name: pool,
        driver: 'zfs',
        config: { source: pool, 'zfs.pool_name': pool, 'zfs.export': 'false' },
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
    profiles: [
      {
        name: 'default',
        project: 'default',
        description: profile.description,
        config: profile.config,
        devices: profile.devices,
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
