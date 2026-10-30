import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Literals of the record version, not reads of today's spec, like the key
 * policy literals in `types.ts`. A stored plan keeps its meaning when these
 * change, and the user-data is never regenerated from current defaults.
 * Before the first release, edit them and reset local development state. After
 * it, a change needs a record-version bump and a versioned reader.
 *
 * The text is declarative on purpose: no commands, packages, storage, private
 * keys, or credentials. Several settings restate cloud-init defaults; they are
 * review surface, not extra enforcement.
 */
const USER = 'qiln'
const CLOUD_CONFIG =
  [
    '#cloud-config',
    'user:',
    '  name: qiln',
    '  lock_passwd: true',
    '  sudo: ALL=(ALL:ALL) NOPASSWD:ALL',
    'ssh_pwauth: false',
    'disable_root: true',
    'allow_public_ssh_keys: true',
    'ssh_deletekeys: true',
    'ssh:',
    '  emit_keys_to_console: true',
  ].join('\n') + '\n'

const SHA256 = createHash('sha256').update(CLOUD_CONFIG, 'utf8').digest('hex')

export const bootstrapSchema = z.strictObject({
  user: z.literal(USER),
  cloudConfig: z.literal(CLOUD_CONFIG),
  sha256: z.literal(SHA256),
})

/**
 * The exact approved UTF-8 text, the administrator account it creates, and the
 * digest of those bytes.
 */
export type Bootstrap = z.infer<typeof bootstrapSchema>

export function bootstrapOf(): Bootstrap {
  return {
    user: USER,
    cloudConfig: CLOUD_CONFIG,
    sha256: SHA256,
  }
}
