import { InstallerError } from '../../../diagnostic/error'
import { dataVolumeId } from '../topology'
import * as deployments from '../records'
import * as zfs from './records'
import { prepared } from './facts'
import type { RecordedPool } from '../../../remote/zfs/types'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'
import type { ZfsRecord } from './types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_STATE_INVALID',
  })
}

export async function evidence(root: Dir, deployment: Deployment): Promise<ZfsRecord | null> {
  return await zfs.read(await deployments.directoryOf(root, deployment.id), deployment)
}

/**
 * The pool that retained evidence expects on this deployment's data volume:
 * its own, else the nearest one carried by the explicit volume-reuse chain.
 * Never searched by tag or pool name. A broken chain, a cycle, or a hop whose
 * previous deployment does not hold the volume it was handed fails closed
 * rather than reading as a blank history. `ready` holds only for this
 * deployment's own evidence, because a previous deployment's pool was exported
 * before the handoff.
 */
export async function pool(root: Dir, deployment: Deployment): Promise<RecordedPool | null> {
  const visited = new Set<string>()
  let current = deployment
  while (true) {
    if (visited.has(current.id)) {
      return invalid()
    }
    visited.add(current.id)
    const record = await evidence(root, current)
    if (record?.pool) {
      return {
        name: record.pool.name,
        guid: record.pool.guid,
        deployment: current.id,
        ready: current.id === deployment.id && prepared(record),
      }
    }
    const { volume } = current.approval.host
    if (volume.kind === 'new') {
      return null
    }
    const previous = await deployments.read(root, volume.from)
    if (previous === null || dataVolumeId(previous) !== volume.volumeId) {
      return invalid()
    }
    current = previous
  }
}
