import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

const SEQUENCE = 0x30
const SET = 0x31
const INTEGER = 0x02
const BIT_STRING = 0x03
const OCTET_STRING = 0x04
const OBJECT_ID = 0x06
const ATTRIBUTES = 0xa0
const DNS_NAME = 0x82
const EXTENSION_REQUEST = Buffer.from('2a864886f70d01090e', 'hex')
const SUBJECT_ALT_NAME = Buffer.from('551d11', 'hex')
const ECDSA_SHA256 = Buffer.from('2a8648ce3d040302', 'hex')

function lengthOf(size: number): Buffer {
  if (size < 0x80) {
    return Buffer.from([size])
  }
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body])
}

export function generateKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
}

export function keyPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString()
}

/**
 * Null means the text is not an unencrypted P-256 private key, which is the
 * only key type the installation retains.
 */
export function parseKey(pem: string): KeyObject | null {
  try {
    const key = createPrivateKey(pem)
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null
  } catch {
    return null
  }
}

/**
 * A narrow PKCS#10 builder for the one request the registration service
 * accepts: version 0, an empty subject, the P-256 public key, and a single
 * extensionRequest attribute carrying one subjectAltName for the apex and the
 * wildcard of `base`, signed with ecdsa-with-SHA256 and absent parameters. The
 * names live only in the SAN, so the subject stays empty. The CSR is public
 * and nondeterministic (ECDSA), so it is rebuilt for every attempt and never
 * retained.
 */
export function csrOf(key: KeyObject, base: string): Buffer {
  const names = [base, `*.${base}`].map(name => der(DNS_NAME, Buffer.from(name, 'ascii')))
  const extension = der(SEQUENCE, der(OBJECT_ID, SUBJECT_ALT_NAME), der(OCTET_STRING, der(SEQUENCE, ...names)))
  const attribute = der(SEQUENCE, der(OBJECT_ID, EXTENSION_REQUEST), der(SET, der(SEQUENCE, extension)))
  const info = der(
    SEQUENCE,
    der(INTEGER, Buffer.from([0])),
    der(SEQUENCE),
    createPublicKey(key).export({ type: 'spki', format: 'der' }),
    der(ATTRIBUTES, attribute),
  )
  return der(
    SEQUENCE,
    info,
    der(SEQUENCE, der(OBJECT_ID, ECDSA_SHA256)),
    der(BIT_STRING, Buffer.from([0]), sign('sha256', info, key)),
  )
}
