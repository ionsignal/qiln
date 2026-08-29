import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  MAX_SSH_PUBLIC_KEY_BLOB_LENGTH,
  SshPublicKeyAlgorithmSchema,
  SshPublicKeyBlobSchema,
} from '../../schemas/ssh/key'

export const SSH_AUTHORIZED_KEYS_SYNC_SUBJECT = 'qiln.private.ssh.authorizedKeys.sync'
export const SSH_AUTHORIZED_KEYS_SYNC_QUEUE = 'qiln-worker-ssh-authorized-keys'
export const SSH_AUTHORIZED_KEYS_SYNC_TIMEOUT_MS = 60_000

const MAX_CANONICAL_AUTHORIZED_KEY_LINE_LENGTH = MAX_SSH_PUBLIC_KEY_BLOB_LENGTH + 64

export const SshAuthorizedKeysDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, {
  message: "SSH authorized-key digests must use the format 'sha256:<64 lowercase hex characters>'.",
})

/**
 * Validates a canonical OpenSSH public-key line containing only the algorithm
 * and canonical base64 public-key blob.
 *
 * Comments, options, extra whitespace, line breaks, and algorithm/blob
 * disagreement are rejected. Full cryptographic key parsing remains owned by
 * the Node-only @qiln/ssh package before Host persistence.
 */
export const SshCanonicalAuthorizedKeyLineSchema = z
  .string()
  .min(1)
  .max(MAX_CANONICAL_AUTHORIZED_KEY_LINE_LENGTH)
  .superRefine((line, context) => {
    if (
      line.includes('\0') ||
      line.includes('\r') ||
      line.includes('\n') ||
      line.includes('\t') ||
      line.trim() !== line
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Canonical SSH authorized-key lines cannot contain control characters or surrounding whitespace.',
      })
      return
    }
    const separatorIndex = line.indexOf(' ')
    if (separatorIndex <= 0 || separatorIndex !== line.lastIndexOf(' ') || separatorIndex === line.length - 1) {
      context.addIssue({
        code: 'custom',
        message: 'Canonical SSH authorized-key lines must contain exactly one separating space.',
      })
      return
    }
    const algorithmValue = line.slice(0, separatorIndex)
    const publicKeyBlobValue = line.slice(separatorIndex + 1)
    const algorithm = SshPublicKeyAlgorithmSchema.safeParse(algorithmValue)
    const publicKeyBlob = SshPublicKeyBlobSchema.safeParse(publicKeyBlobValue)
    if (!algorithm.success) {
      context.addIssue({
        code: 'custom',
        path: ['algorithm'],
        message: 'Canonical SSH authorized-key line uses an unsupported public-key algorithm.',
      })
    }
    if (!publicKeyBlob.success) {
      context.addIssue({
        code: 'custom',
        path: ['publicKeyBlob'],
        message: 'Canonical SSH authorized-key line contains an invalid public-key blob.',
      })
    }
    if (!algorithm.success || !publicKeyBlob.success) {
      return
    }
    const decodedBlob = Buffer.from(publicKeyBlob.data, 'base64')
    if (
      decodedBlob.length < 5 ||
      decodedBlob.length > MAX_SSH_PUBLIC_KEY_BLOB_LENGTH ||
      decodedBlob.toString('base64') !== publicKeyBlob.data
    ) {
      context.addIssue({
        code: 'custom',
        path: ['publicKeyBlob'],
        message: 'Canonical SSH authorized-key line contains a noncanonical public-key blob.',
      })
      return
    }
    const encodedAlgorithmLength = decodedBlob.readUInt32BE(0)
    const encodedAlgorithmEnd = 4 + encodedAlgorithmLength
    if (
      encodedAlgorithmLength === 0 ||
      encodedAlgorithmEnd > decodedBlob.length ||
      encodedAlgorithmEnd === decodedBlob.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['publicKeyBlob'],
        message: 'Canonical SSH authorized-key line contains a malformed public-key blob.',
      })
      return
    }
    const encodedAlgorithmBytes = decodedBlob.subarray(4, encodedAlgorithmEnd)
    const encodedAlgorithm = encodedAlgorithmBytes.toString('ascii')
    if (!encodedAlgorithmBytes.equals(Buffer.from(encodedAlgorithm, 'ascii')) || encodedAlgorithm !== algorithm.data) {
      context.addIssue({
        code: 'custom',
        path: ['publicKeyBlob'],
        message: 'Canonical SSH authorized-key line algorithm does not match its public-key blob.',
      })
    }
  })

export interface EncodedSshAuthorizedKeys {
  keyLines: string[]
  bytes: Uint8Array
  digest: `sha256:${string}`
}

/**
 * Produces the canonical ordered key-line set.
 *
 * Ordering is raw UTF-8 byte ordering rather than locale-sensitive text
 * ordering. Duplicate canonical lines are removed before encoding.
 */
export function canonicalizeSshAuthorizedKeyLines(keyLines: readonly string[]): string[] {
  const uniqueLines = new Set<string>()
  for (const value of keyLines) {
    uniqueLines.add(SshCanonicalAuthorizedKeyLineSchema.parse(value))
  }
  return [...uniqueLines].sort((left, right) => {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  })
}

export function digestSshAuthorizedKeysBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Encodes the exact bytes written to a branch authorized-keys file.
 *
 * An empty key set is represented by zero bytes. Every non-empty line is
 * terminated by one LF byte, including the final line.
 */
export function encodeSshAuthorizedKeys(keyLines: readonly string[]): EncodedSshAuthorizedKeys {
  const canonicalKeyLines = canonicalizeSshAuthorizedKeyLines(keyLines)
  const bytes =
    canonicalKeyLines.length === 0
      ? new Uint8Array()
      : new Uint8Array(Buffer.from(`${canonicalKeyLines.join('\n')}\n`, 'utf8'))
  return {
    keyLines: canonicalKeyLines,
    bytes,
    digest: digestSshAuthorizedKeysBytes(bytes),
  }
}

const SshAuthorizedKeysSyncRequestFieldsSchema = z
  .object({
    ownerId: z.uuid(),
    capsuleId: z.uuid(),
    branchId: z.uuid(),
    keyLines: z.array(SshCanonicalAuthorizedKeyLineSchema),
    digest: SshAuthorizedKeysDigestSchema,
  })
  .strict()

/**
 * Private Host-to-Worker authorized-key synchronization request.
 *
 * Validation reconstructs the exact canonical bytes and rejects duplicate,
 * unsorted, or digest-inconsistent requests before a Worker handler runs.
 */
export const SshAuthorizedKeysSyncRequestSchema = SshAuthorizedKeysSyncRequestFieldsSchema.superRefine(
  (request, context) => {
    const encoded = encodeSshAuthorizedKeys(request.keyLines)
    const canonicalOrderMatches =
      encoded.keyLines.length === request.keyLines.length &&
      encoded.keyLines.every((line, index) => line === request.keyLines[index])
    if (!canonicalOrderMatches) {
      context.addIssue({
        code: 'custom',
        path: ['keyLines'],
        message: 'SSH authorized-key sync lines must be deduplicated and sorted by their UTF-8 bytes.',
      })
    }
    if (encoded.digest !== request.digest) {
      context.addIssue({
        code: 'custom',
        path: ['digest'],
        message: 'SSH authorized-key sync digest does not match the exact canonical file bytes.',
      })
    }
  },
)

export const SshAuthorizedKeysSyncAckSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict()

export type SshCanonicalAuthorizedKeyLine = z.infer<typeof SshCanonicalAuthorizedKeyLineSchema>
export type SshAuthorizedKeysDigest = z.infer<typeof SshAuthorizedKeysDigestSchema>
export type SshAuthorizedKeysSyncRequestInput = z.input<typeof SshAuthorizedKeysSyncRequestSchema>
export type SshAuthorizedKeysSyncRequest = z.output<typeof SshAuthorizedKeysSyncRequestSchema>
export type SshAuthorizedKeysSyncAck = z.infer<typeof SshAuthorizedKeysSyncAckSchema>

export type SshAuthorizedKeysSyncHandler = (
  request: SshAuthorizedKeysSyncRequest,
) => Promise<SshAuthorizedKeysSyncAck> | SshAuthorizedKeysSyncAck

export function createSshAuthorizedKeysSyncRequest(input: {
  ownerId: string
  capsuleId: string
  branchId: string
  keyLines: readonly string[]
}): SshAuthorizedKeysSyncRequest {
  const encoded = encodeSshAuthorizedKeys(input.keyLines)
  return SshAuthorizedKeysSyncRequestSchema.parse({
    ownerId: input.ownerId,
    capsuleId: input.capsuleId,
    branchId: input.branchId,
    keyLines: encoded.keyLines,
    digest: encoded.digest,
  })
}

export function parseSshAuthorizedKeysSyncRequest(value: unknown): SshAuthorizedKeysSyncRequest {
  return SshAuthorizedKeysSyncRequestSchema.parse(value)
}
