import { createHash } from 'node:crypto'
import { openChildDir, readChild, type Dir } from '../../state/files'
import { userId } from '../host'
import { AWS_SPEC } from '../spec'
import { notAttempted } from './context'

export interface PublicKey {
  bytes: Uint8Array
  fingerprint: string
}

export type KeyReader = () => Promise<PublicKey>

const OPENSSH_ED25519 = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/

function fingerprintOf(blob: string): string {
  return createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')
}

export function sameFingerprint(reported: string | undefined, expected: string): boolean {
  return reported?.replace(/^SHA256:/, '').replace(/=+$/, '') === expected
}

/**
 * Reads the retained administrative public key from the deployment's protected
 * directory. A missing or malformed key is a refusal before any dispatch and
 * never causes a key to be generated or replaced.
 */
export function keyReader(root: Dir, deploymentId: string): KeyReader {
  return async () => {
    try {
      const ownership = {
        owner: userId(),
        mode: 0o700,
      }
      const store = await openChildDir(root, AWS_SPEC.state.deployments, ownership)
      const directory = await openChildDir(store, deploymentId, ownership)
      const snapshot = await readChild(directory, AWS_SPEC.state.publicKey, {
        owner: userId(),
        mode: 0o600,
        minSize: 1,
        maxSize: AWS_SPEC.limits.publicKey,
      })
      const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes).trim()
      const match = OPENSSH_ED25519.exec(text)
      if (match === null) {
        return notAttempted()
      }
      return { bytes: snapshot.bytes, fingerprint: fingerprintOf(match[1]) }
    } catch {
      return notAttempted()
    }
  }
}
