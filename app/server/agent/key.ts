import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const AGENT_KEY_PREFIX = 'qak_v1'
const AGENT_KEY_SECRET_BYTES = 32
const AGENT_KEY_SALT_BYTES = 16
const AGENT_KEY_DERIVED_BYTES = 32
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024

const AGENT_CREDENTIAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

interface StoredAgentKeyHash {
  salt: Buffer
  digest: Buffer
}

export interface ParsedAgentKey {
  credentialId: string
  secret: Buffer
}

export interface GeneratedAgentKey {
  key: string
  keyHash: string
}

const dummySecret = Buffer.alloc(AGENT_KEY_SECRET_BYTES)
const dummyHash = encodeHash(Buffer.alloc(AGENT_KEY_SALT_BYTES), Buffer.alloc(AGENT_KEY_DERIVED_BYTES))

function encodeHash(salt: Buffer, digest: Buffer): string {
  return [
    'scrypt',
    'v1',
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$')
}

function decodeBase64Url(value: string, expectedLength: number): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) {
    return null
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== expectedLength || decoded.toString('base64url') !== value) {
    return null
  }
  return decoded
}

function parseHash(value: string): StoredAgentKeyHash | null {
  const [algorithm, version, cost, blockSize, parallelization, saltValue, digestValue, extra] = value.split('$')
  if (
    algorithm !== 'scrypt' ||
    version !== 'v1' ||
    cost !== String(SCRYPT_COST) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelization !== String(SCRYPT_PARALLELIZATION) ||
    saltValue === undefined ||
    digestValue === undefined ||
    extra !== undefined
  ) {
    return null
  }
  const salt = decodeBase64Url(saltValue, AGENT_KEY_SALT_BYTES)
  const digest = decodeBase64Url(digestValue, AGENT_KEY_DERIVED_BYTES)
  if (!salt || !digest) {
    return null
  }
  return {
    salt,
    digest,
  }
}

function derive(secret: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      AGENT_KEY_DERIVED_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error)
          return
        }
        resolve(derivedKey)
      },
    )
  })
}

/**
 * Extracts the opaque credential locator and secret from a canonical Qiln API
 * key. The credential ID is not secret; only the random key secret
 * authenticates a caller.
 */
export function parseAgentKey(value: string): ParsedAgentKey | null {
  if (value.length === 0 || value.length > 512) {
    return null
  }
  const [prefix, credentialId, secretValue, extra] = value.split('.')
  if (
    prefix !== AGENT_KEY_PREFIX ||
    credentialId === undefined ||
    secretValue === undefined ||
    extra !== undefined ||
    !AGENT_CREDENTIAL_ID_PATTERN.test(credentialId)
  ) {
    return null
  }
  const secret = decodeBase64Url(secretValue, AGENT_KEY_SECRET_BYTES)
  if (!secret) {
    return null
  }
  return {
    credentialId: credentialId.toLowerCase(),
    secret,
  }
}

/**
 * Extracts one canonical bearer key without accepting alternate authorization
 * schemes or values that can be ambiguously split by intermediaries.
 */
export function readAgentBearerKey(authorization: string | undefined): string | null {
  if (!authorization || authorization.length > 512) {
    return null
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization)
  return match?.[1] ?? null
}

/**
 * Generates a one-time plaintext key and the only value Qiln persists for it.
 */
export async function createAgentKey(credentialId: string): Promise<GeneratedAgentKey> {
  if (!AGENT_CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new RangeError('Agent credential IDs must be UUIDs before generating an API key.')
  }
  const secret = randomBytes(AGENT_KEY_SECRET_BYTES)
  const salt = randomBytes(AGENT_KEY_SALT_BYTES)
  const digest = await derive(secret, salt)
  return {
    key: `${AGENT_KEY_PREFIX}.${credentialId.toLowerCase()}.${secret.toString('base64url')}`,
    keyHash: encodeHash(salt, digest),
  }
}

/**
 * Verifies a candidate secret without exposing whether the stored hash was
 * absent or malformed. Unknown credentials use the same scrypt work factor.
 */
export async function verifyAgentKeyHash(keyHash: string | null, secret: Buffer): Promise<boolean> {
  const parsed = keyHash === null ? null : parseHash(keyHash)
  const candidate = parsed ?? parseHash(dummyHash)!
  const digest = await derive(secret, candidate.salt)
  const matches = timingSafeEqual(digest, candidate.digest)
  return parsed !== null && matches
}

/**
 * Performs equivalent scrypt work for malformed or missing API keys so those
 * paths do not become a cheap credential-enumeration oracle.
 */
export async function consumeUnknownAgentKeyVerification(): Promise<void> {
  await verifyAgentKeyHash(null, dummySecret)
}
