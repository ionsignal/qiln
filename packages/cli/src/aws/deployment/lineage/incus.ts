import { InstallerError } from '../../../diagnostic/error'
import { chain } from './chain'
import { evidence } from '../incus/evidence'
import { artifactsOf, requireStorageReleased, retainedPreseedBytes } from '../incus/facts'
import type { Retained } from '../../../host/incus/types'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'

/**
 * The Incus installation that this deployment may reopen: the nearest record on
 * the explicit volume chain that established a baseline, with its retained
 * preseed, software, and server identity. An ancestor must also have a verified
 * release after its last opening, so a volume is never reopened from a daemon
 * that may still hold it. The retained package files are the manifest of the
 * nearest capture at or beyond that record: the artifacts dataset lives on the
 * volume, so a host that only reopened the installation did not change it. A
 * baseline with no capture anywhere on the chain is invalid. Null means nothing
 * on the chain was ever initialized, which is the fresh path.
 */
export async function retained(root: Dir, deployment: Deployment): Promise<Retained | null> {
  let found: Omit<Retained, 'artifacts'> | null = null
  for await (const link of chain(root, deployment)) {
    const record = await evidence(root, link)
    if (record === null) {
      continue
    }
    if (found === null) {
      if (record.baseline === null) {
        continue
      }
      if (link.id !== deployment.id) {
        requireStorageReleased(record, link.id)
      }
      const preseed = retainedPreseedBytes(record)
      if (record.identity === null || preseed === null) {
        throw new InstallerError({
          code: 'AWS_INCUS_STATE_INVALID',
        })
      }
      found = { origin: link.id, preseed, baseline: record.baseline, identity: record.identity }
    }
    const artifacts = artifactsOf(record)
    if (artifacts !== null) {
      return { ...found, artifacts }
    }
  }
  if (found !== null) {
    throw new InstallerError({
      code: 'AWS_INCUS_STATE_INVALID',
    })
  }
  return null
}
