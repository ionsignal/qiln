import { z } from 'zod'
import { isFingerprint } from '../../ssh/key'
import { isTimestamp } from '../types'
import { KIND_IDS } from './graph'

/**
 * A version-1 literal shape, like the other retained evidence. `source` names
 * the only channel that supplied it: the guest's console output as reported by
 * AWS. It is not an AWS-signed certificate or guest attestation, and it is
 * distinct from both the administrative login key and the EC2 key-pair
 * fingerprint.
 */
export const hostKeySchema = z.strictObject({
  address: z.ipv4(),
  allocationId: z.string().regex(KIND_IDS.address),
  instanceId: z.string().regex(KIND_IDS.instance),
  algorithm: z.literal('ed25519'),
  fingerprint: z.string().refine(isFingerprint, 'Expected an unpadded SHA-256 fingerprint.'),
  source: z.literal('ec2-console'),
  consoleAt: z.string().refine(isTimestamp, 'Expected a canonical timestamp.'),
  observedAt: z.string().refine(isTimestamp, 'Expected a canonical timestamp.'),
})

export type HostKey = z.infer<typeof hostKeySchema>

export function isHostKey(value: unknown): value is HostKey {
  return hostKeySchema.safeParse(value).success
}
