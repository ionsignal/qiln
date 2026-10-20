import { AWS_SPEC } from '../spec'
import { userId } from '../host'
import { privateKeyFingerprint } from '../../ssh/identity'
import { InstallerError } from '../../diagnostic/error'
import { readChild, type Dir } from '../../state/files'
import { openSshDir } from './store'
import type { Deployment } from '../deployment/types'

function refuse(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_ACCESS_REFUSED',
  })
}

/**
 * Kept apart from `store.ts` because this module loads `ssh2` through the key
 * parser, and the EC2 credential child imports `store.ts`.
 *
 * The recorded binding is the authority: a missing, unprotected, or different
 * key is a refusal before any connection, and never causes a key to be
 * generated, replaced, or repaired. The caller zeroes the returned buffer.
 */
export async function readPrivateKey(root: Dir, record: Deployment): Promise<Buffer> {
  try {
    if (record.adminKey === null) {
      return refuse()
    }
    const directory = await openSshDir(root, record.id)
    const snapshot = await readChild(directory, AWS_SPEC.state.privateKey, {
      owner: userId(),
      mode: 0o600,
      minSize: 1,
      maxSize: AWS_SPEC.limits.privateKey,
    })
    const key = Buffer.from(snapshot.bytes)
    snapshot.bytes.fill(0)
    if (privateKeyFingerprint(key) !== record.adminKey.fingerprint) {
      key.fill(0)
      return refuse()
    }
    return key
  } catch {
    return refuse()
  }
}
