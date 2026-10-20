import { utils } from 'ssh2'
import { fingerprintOf } from './key'

interface ParsedPrivateKey {
  type: string
  isPrivateKey(): boolean
  getPublicSSH(): Buffer
}

function isParsedKey(value: unknown): value is ParsedPrivateKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'isPrivateKey' in value &&
    typeof value.isPrivateKey === 'function' &&
    'getPublicSSH' in value &&
    typeof value.getPublicSSH === 'function'
  )
}

/**
 * Derives the public fingerprint of an unencrypted Ed25519 private key. Null
 * means the bytes are not such a key, so callers refuse before connecting.
 */
export function privateKeyFingerprint(privateKey: Buffer): string | null {
  try {
    const parsed: unknown = utils.parseKey(privateKey)
    const keys: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    const [key] = keys
    if (keys.length !== 1 || !isParsedKey(key) || key.type !== 'ssh-ed25519' || !key.isPrivateKey()) {
      return null
    }
    const blob = key.getPublicSSH()
    return Buffer.isBuffer(blob) ? fingerprintOf(blob) : null
  } catch {
    return null
  }
}
