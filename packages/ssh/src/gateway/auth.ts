import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { SshPublicKeyAlgorithm } from '@qiln/core/server'
import { parseSshPublicKeyBlob } from '../key'
import { ssh2Utils } from '../ssh2'
import type { PublicKeyAuthContext } from 'ssh2'
import type { SshCanonicalPublicKey } from '@qiln/core/server'
import type { SshGatewayHostPolicy } from './types'

export const SSH_GATEWAY_OUTER_USERNAME = 'qiln-gateway'

export type SshGatewayAuthenticationResult =
  | {
      kind: 'probe_accepted'
    }
  | {
      kind: 'probe_rejected'
    }
  | {
      kind: 'authenticated'
      key: SshCanonicalPublicKey
      ticket: string
    }
  | {
      kind: 'rejected'
    }

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Allows RSA key blobs only when the SSH user-authentication signature uses
 * RSA-SHA2. `ssh-rsa` remains the RSA key-blob format, but SHA-1 signatures are
 * not accepted by the Qiln gateway.
 */
function hasApprovedUserAuthenticationSignature(context: PublicKeyAuthContext, key: SshCanonicalPublicKey): boolean {
  if (key.algorithm !== SshPublicKeyAlgorithm.RSA) {
    return true
  }
  return context.hashAlgo === 'sha256' || context.hashAlgo === 'sha512'
}

/**
 * Verifies a signed ssh2 public-key authentication request using ssh2's parsed
 * key primitive and the exact userauth blob and signature supplied by ssh2.
 *
 * Cryptographic verification remains inside ssh2. Qiln performs only identity
 * consistency checks around that primitive.
 */
export function verifySignedPublicKeyRequest(context: PublicKeyAuthContext, key: SshCanonicalPublicKey): boolean {
  if (!context.signature || !context.blob) {
    return false
  }
  if (!hasApprovedUserAuthenticationSignature(context, key)) {
    return false
  }
  const parsedKey = ssh2Utils.parseKey(context.key.data)
  if (parsedKey instanceof Error || Array.isArray(parsedKey)) {
    return false
  }
  if (parsedKey.type !== context.key.algo || parsedKey.type !== key.algorithm) {
    return false
  }
  let parsedPublicBlob: Buffer
  try {
    parsedPublicBlob = parsedKey.getPublicSSH()
  } catch {
    return false
  }
  const canonicalPublicBlob = Buffer.from(key.publicKeyBlob, 'base64')
  if (!buffersEqual(parsedPublicBlob, canonicalPublicBlob)) {
    return false
  }
  try {
    return parsedKey.verify(context.blob, context.signature, context.hashAlgo) === true
  } catch {
    return false
  }
}

/**
 * Evaluates one public-key authentication request.
 *
 * Unsigned requests are eligibility probes only. A plaintext ticket is returned
 * only after ssh2 has verified the signed userauth payload.
 */
export async function authenticateGatewayPublicKey(
  context: PublicKeyAuthContext,
  policy: SshGatewayHostPolicy,
): Promise<SshGatewayAuthenticationResult> {
  if (context.username !== SSH_GATEWAY_OUTER_USERNAME) {
    return {
      kind: 'rejected',
    }
  }
  let key: SshCanonicalPublicKey
  try {
    key = parseSshPublicKeyBlob(context.key.data, context.key.algo)
  } catch {
    return {
      kind: context.signature ? 'rejected' : 'probe_rejected',
    }
  }
  if (!context.signature) {
    try {
      const eligibility = await policy.checkGatewayKeyEligibility(key)
      return {
        kind: eligibility.eligible ? 'probe_accepted' : 'probe_rejected',
      }
    } catch {
      return {
        kind: 'probe_rejected',
      }
    }
  }
  if (!verifySignedPublicKeyRequest(context, key)) {
    return {
      kind: 'rejected',
    }
  }
  try {
    const issued = await policy.issueGatewayTicket(key)
    return {
      kind: 'authenticated',
      key,
      ticket: issued.ticket,
    }
  } catch {
    return {
      kind: 'rejected',
    }
  }
}
