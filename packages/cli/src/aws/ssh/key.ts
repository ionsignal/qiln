import { createHash } from 'node:crypto'

export interface PublicKey {
  blob: Buffer
  fingerprint: string
}

const NAME = Buffer.from('ssh-ed25519')
const KEY_BYTES = 32
const LINE = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/
const FINGERPRINT = /^[A-Za-z0-9+/]{43}$/

export function fingerprintOf(blob: Uint8Array): string {
  return createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

export function isFingerprint(value: unknown): value is string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) {
    return false
  }
  const digest = Buffer.from(value, 'base64')
  return digest.byteLength === 32 && digest.toString('base64').replace(/=+$/, '') === value
}

export function sameFingerprint(reported: string | undefined, expected: string): boolean {
  return reported?.replace(/^SHA256:/, '').replace(/=+$/, '') === expected
}

function isWireFormat(blob: Buffer): boolean {
  return (
    blob.length === 4 + NAME.length + 4 + KEY_BYTES &&
    blob.readUInt32BE(0) === NAME.length &&
    blob.subarray(4, 4 + NAME.length).equals(NAME) &&
    blob.readUInt32BE(4 + NAME.length) === KEY_BYTES
  )
}

export function parsePublicKey(line: string): PublicKey | null {
  const text = LINE.exec(line)?.[1]
  if (text === undefined) {
    return null
  }
  const blob = Buffer.from(text, 'base64')
  if (blob.toString('base64') !== text || !isWireFormat(blob)) {
    return null
  }
  return { blob, fingerprint: fingerprintOf(blob) }
}
