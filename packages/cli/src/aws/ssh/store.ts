import { AWS_SPEC } from '../spec'
import { userId } from '../host'
import { parsePublicKey } from '../../ssh/key'
import { InstallerError } from '../../diagnostic/error'
import { openChildDir, readChild, type Dir } from '../../state/files'
import type { Deployment } from '../deployment/types'

export interface PublicKeyFile {
  bytes: Uint8Array
  fingerprint: string
}

export type PublicKeyReader = () => Promise<PublicKeyFile>

function refuse(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_NOT_ATTEMPTED',
  })
}

/** Opens the existing protected SSH directory of one deployment. It never creates it. */
export async function openSshDir(root: Dir, deploymentId: string): Promise<Dir> {
  const ownership = {
    owner: userId(),
    mode: 0o700,
  }
  const store = await openChildDir(root, AWS_SPEC.state.deployments, ownership)
  const deployment = await openChildDir(store, deploymentId, ownership)
  return await openChildDir(deployment, AWS_SPEC.state.ssh, ownership)
}

/**
 * Reads the administrative public key for import dispatch. The recorded binding
 * is the authority: a missing, malformed, or different key is a refusal before
 * any dispatch, and never causes a key to be generated or replaced.
 */
export async function readPublicKey(root: Dir, record: Deployment): Promise<PublicKeyFile> {
  try {
    if (record.adminKey === null) {
      return refuse()
    }
    const directory = await openSshDir(root, record.id)
    const snapshot = await readChild(directory, AWS_SPEC.state.publicKey, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: AWS_SPEC.limits.publicKey,
    })
    const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes).trim()
    const key = parsePublicKey(text)
    if (key === null || key.fingerprint !== record.adminKey.fingerprint) {
      return refuse()
    }
    return { bytes: snapshot.bytes, fingerprint: key.fingerprint }
  } catch {
    return refuse()
  }
}
