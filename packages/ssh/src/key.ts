import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  MAX_SSH_PUBLIC_KEY_BLOB_LENGTH,
  MAX_SSH_PUBLIC_KEY_LINE_LENGTH,
  SshCanonicalPublicKeySchema,
  SshPublicKeyAlgorithmSchema,
  SshPublicKeyBlobSchema,
  type SshCanonicalPublicKey,
  type SshPublicKeyAlgorithm,
  type SshPublicKeyBlob,
  type SshPublicKeyFingerprint,
} from '@qiln/core/server'
import { ssh2Utils } from './ssh2'

const OPENSSH_PUBLIC_KEY_LINE_PATTERN = /^(\S+)[\t ]+(\S+)(?:[\t ]+.*)?$/
const PUBLIC_KEY_LINE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export const SshPublicKeyErrorCode = {
  INVALID_LINE: 'INVALID_LINE',
  UNSUPPORTED_ALGORITHM: 'UNSUPPORTED_ALGORITHM',
  INVALID_BASE64: 'INVALID_BASE64',
  INVALID_BLOB: 'INVALID_BLOB',
  ALGORITHM_MISMATCH: 'ALGORITHM_MISMATCH',
} as const

export type SshPublicKeyErrorCode = (typeof SshPublicKeyErrorCode)[keyof typeof SshPublicKeyErrorCode]

export interface SshPublicKeyErrorOptions {
  code: SshPublicKeyErrorCode
  details?: Record<string, unknown>
}

export class SshPublicKeyError extends Error {
  public readonly code: SshPublicKeyErrorCode
  public readonly details?: Record<string, unknown>

  constructor(message: string, options: SshPublicKeyErrorOptions) {
    super(message)
    this.name = 'SshPublicKeyError'
    this.code = options.code
    this.details = options.details
  }
}

/**
 * Canonical result produced from a normal OpenSSH public-key line or raw SSH
 * public-key blob.
 *
 * Comments and other user-facing registration metadata are intentionally not
 * part of key identity.
 */
export interface ParsedSshPublicKey extends SshCanonicalPublicKey {
  canonicalOpenSshPublicKey: string
}

function parseSupportedAlgorithm(value: unknown): SshPublicKeyAlgorithm {
  const parsed = SshPublicKeyAlgorithmSchema.safeParse(value)
  if (!parsed.success) {
    throw new SshPublicKeyError('The SSH public-key algorithm is not supported.', {
      code: SshPublicKeyErrorCode.UNSUPPORTED_ALGORITHM,
      details: {
        algorithm: typeof value === 'string' ? value : null,
      },
    })
  }
  return parsed.data
}

function parseCanonicalBase64(value: string): Buffer {
  const parsed = SshPublicKeyBlobSchema.safeParse(value)
  if (!parsed.success) {
    throw new SshPublicKeyError('The SSH public-key blob is not canonical base64.', {
      code: SshPublicKeyErrorCode.INVALID_BASE64,
    })
  }

  let decoded: Buffer
  try {
    decoded = Buffer.from(parsed.data, 'base64')
  } catch (error: unknown) {
    throw new SshPublicKeyError('The SSH public-key blob could not be decoded.', {
      code: SshPublicKeyErrorCode.INVALID_BASE64,
      details: {
        reason: error instanceof Error ? error.message : 'Unknown base64 decoding failure',
      },
    })
  }

  if (decoded.length === 0 || decoded.length > MAX_SSH_PUBLIC_KEY_BLOB_LENGTH) {
    throw new SshPublicKeyError('The SSH public-key blob has an unsupported size.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        blobLength: decoded.length,
        maximumBlobLength: MAX_SSH_PUBLIC_KEY_BLOB_LENGTH,
      },
    })
  }

  if (decoded.toString('base64') !== parsed.data) {
    throw new SshPublicKeyError('The SSH public-key blob is not in canonical base64 form.', {
      code: SshPublicKeyErrorCode.INVALID_BASE64,
    })
  }

  return decoded
}

function readBlobAlgorithm(publicKeyBlob: Buffer): SshPublicKeyAlgorithm {
  if (publicKeyBlob.length < 5) {
    throw new SshPublicKeyError('The SSH public-key blob is truncated.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        blobLength: publicKeyBlob.length,
      },
    })
  }

  const algorithmLength = publicKeyBlob.readUInt32BE(0)
  const algorithmEnd = 4 + algorithmLength

  if (algorithmLength === 0 || algorithmEnd > publicKeyBlob.length) {
    throw new SshPublicKeyError('The SSH public-key blob has an invalid algorithm field.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        blobLength: publicKeyBlob.length,
        algorithmLength,
      },
    })
  }

  const algorithmBytes = publicKeyBlob.subarray(4, algorithmEnd)
  const algorithm = algorithmBytes.toString('ascii')

  if (!algorithmBytes.equals(Buffer.from(algorithm, 'ascii'))) {
    throw new SshPublicKeyError('The SSH public-key algorithm is not valid ASCII.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
    })
  }

  return parseSupportedAlgorithm(algorithm)
}

function assertAlgorithmMatches(
  expectedAlgorithm: SshPublicKeyAlgorithm,
  actualAlgorithm: SshPublicKeyAlgorithm,
): void {
  if (expectedAlgorithm === actualAlgorithm) {
    return
  }

  throw new SshPublicKeyError('The SSH public-key algorithm does not match its encoded key blob.', {
    code: SshPublicKeyErrorCode.ALGORITHM_MISMATCH,
    details: {
      expectedAlgorithm,
      actualAlgorithm,
    },
  })
}

function parseWithSsh2(publicKey: string | Buffer) {
  const parsed = ssh2Utils.parseKey(publicKey)

  if (parsed instanceof Error) {
    throw new SshPublicKeyError('The SSH public key is malformed or unsupported.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        reason: parsed.message,
      },
    })
  }

  if (Array.isArray(parsed)) {
    throw new SshPublicKeyError('Exactly one SSH public key is required.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        keyCount: parsed.length,
      },
    })
  }

  return parsed
}

function canonicalizePublicKeyBlob(
  publicKeyBlob: Buffer,
  expectedAlgorithm?: SshPublicKeyAlgorithm,
): {
  algorithm: SshPublicKeyAlgorithm
  publicKeyBlob: Buffer
} {
  const encodedAlgorithm = readBlobAlgorithm(publicKeyBlob)

  if (expectedAlgorithm !== undefined) {
    assertAlgorithmMatches(expectedAlgorithm, encodedAlgorithm)
  }

  const parsedKey = parseWithSsh2(publicKeyBlob)
  const parsedAlgorithm = parseSupportedAlgorithm(parsedKey.type)

  assertAlgorithmMatches(encodedAlgorithm, parsedAlgorithm)

  let canonicalBlob: Buffer
  try {
    canonicalBlob = parsedKey.getPublicSSH()
  } catch (error: unknown) {
    throw new SshPublicKeyError('The SSH public key could not be converted to canonical public-key form.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        algorithm: parsedAlgorithm,
        reason: error instanceof Error ? error.message : 'Unknown public-key canonicalization failure',
      },
    })
  }

  if (!Buffer.isBuffer(canonicalBlob) || canonicalBlob.length === 0) {
    throw new SshPublicKeyError('The SSH public key produced no canonical public-key blob.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        algorithm: parsedAlgorithm,
      },
    })
  }

  if (canonicalBlob.length > MAX_SSH_PUBLIC_KEY_BLOB_LENGTH) {
    throw new SshPublicKeyError('The canonical SSH public-key blob exceeds the supported size.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        algorithm: parsedAlgorithm,
        blobLength: canonicalBlob.length,
        maximumBlobLength: MAX_SSH_PUBLIC_KEY_BLOB_LENGTH,
      },
    })
  }

  const canonicalAlgorithm = readBlobAlgorithm(canonicalBlob)

  assertAlgorithmMatches(parsedAlgorithm, canonicalAlgorithm)

  return {
    algorithm: canonicalAlgorithm,
    publicKeyBlob: Buffer.from(canonicalBlob),
  }
}

/**
 * Produces the canonical OpenSSH SHA-256 fingerprint for a canonical public-key
 * blob.
 *
 * Fingerprints are lookup and display identifiers. Host authorization must
 * additionally compare the canonical algorithm and complete canonical key
 * blob.
 */
export function fingerprintSshPublicKeyBlob(publicKeyBlob: Uint8Array): SshPublicKeyFingerprint {
  const blob = Buffer.from(publicKeyBlob)

  if (blob.length === 0 || blob.length > MAX_SSH_PUBLIC_KEY_BLOB_LENGTH) {
    throw new SshPublicKeyError('The SSH public-key blob has an unsupported size.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        blobLength: blob.length,
        maximumBlobLength: MAX_SSH_PUBLIC_KEY_BLOB_LENGTH,
      },
    })
  }

  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/**
 * Parses and canonicalizes an SSH wire-format public-key blob.
 *
 * This is the gateway-facing boundary for keys actually offered during SSH
 * authentication. An optional expected algorithm must come from the same SSH
 * authentication request, not from client-supplied branch or grant metadata.
 */
export function parseSshPublicKeyBlob(publicKeyBlob: Uint8Array, expectedAlgorithm?: string): ParsedSshPublicKey {
  const blob = Buffer.from(publicKeyBlob)

  if (blob.length === 0 || blob.length > MAX_SSH_PUBLIC_KEY_BLOB_LENGTH) {
    throw new SshPublicKeyError('The SSH public-key blob has an unsupported size.', {
      code: SshPublicKeyErrorCode.INVALID_BLOB,
      details: {
        blobLength: blob.length,
        maximumBlobLength: MAX_SSH_PUBLIC_KEY_BLOB_LENGTH,
      },
    })
  }

  const parsedExpectedAlgorithm =
    expectedAlgorithm === undefined ? undefined : parseSupportedAlgorithm(expectedAlgorithm)
  const canonical = canonicalizePublicKeyBlob(blob, parsedExpectedAlgorithm)
  const publicKeyBlobBase64 = canonical.publicKeyBlob.toString('base64') as SshPublicKeyBlob

  const identity = SshCanonicalPublicKeySchema.parse({
    algorithm: canonical.algorithm,
    publicKeyBlob: publicKeyBlobBase64,
    fingerprint: fingerprintSshPublicKeyBlob(canonical.publicKeyBlob),
  })

  return Object.freeze({
    ...identity,
    canonicalOpenSshPublicKey: `${identity.algorithm} ${identity.publicKeyBlob}`,
  })
}

/**
 * Parses a normal OpenSSH public-key registration line.
 *
 * Authorized-keys options, certificates, FIDO/security-key algorithms, DSA,
 * private keys, and multi-key inputs fail closed. An optional trailing OpenSSH
 * comment is discarded before canonical identity is generated.
 */
export function parseOpenSshPublicKey(publicKeyLine: string): ParsedSshPublicKey {
  if (
    typeof publicKeyLine !== 'string' ||
    publicKeyLine.length === 0 ||
    publicKeyLine.length > MAX_SSH_PUBLIC_KEY_LINE_LENGTH ||
    publicKeyLine.includes('\0') ||
    publicKeyLine.includes('\r') ||
    publicKeyLine.includes('\n') ||
    PUBLIC_KEY_LINE_CONTROL_CHARACTER_PATTERN.test(publicKeyLine)
  ) {
    throw new SshPublicKeyError('A normal OpenSSH public key must be supplied as one bounded line.', {
      code: SshPublicKeyErrorCode.INVALID_LINE,
    })
  }

  const normalizedLine = publicKeyLine.trim()
  const match = OPENSSH_PUBLIC_KEY_LINE_PATTERN.exec(normalizedLine)

  if (!match) {
    throw new SshPublicKeyError('The OpenSSH public-key line is malformed.', {
      code: SshPublicKeyErrorCode.INVALID_LINE,
    })
  }

  const advertisedAlgorithm = parseSupportedAlgorithm(match[1])
  const decodedBlob = parseCanonicalBase64(match[2]!)
  const canonical = parseSshPublicKeyBlob(decodedBlob, advertisedAlgorithm)

  /*
   * Parsing the canonical line once more through ssh2 ensures the line form
   * accepted for storage is itself consumable by the SSH implementation used by
   * the gateway.
   */
  const parsedCanonicalKey = parseWithSsh2(canonical.canonicalOpenSshPublicKey)
  const parsedCanonicalAlgorithm = parseSupportedAlgorithm(parsedCanonicalKey.type)

  assertAlgorithmMatches(canonical.algorithm, parsedCanonicalAlgorithm)

  return canonical
}
