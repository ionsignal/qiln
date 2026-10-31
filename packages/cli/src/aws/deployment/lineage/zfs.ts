import { chain } from './chain'
import { prepared, staged } from '../zfs/facts'
import * as zfs from '../zfs/records'
import * as deployments from '../records'
import type { RecordedPool } from '../../../host/zfs/types'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'
import type { ZfsRecord } from '../zfs/types'

export async function evidence(root: Dir, deployment: Deployment): Promise<ZfsRecord | null> {
  return await zfs.read(await deployments.directoryOf(root, deployment.id), deployment)
}

/**
 * The pool that retained evidence expects on this deployment's data volume:
 * its own, else the nearest one carried by the explicit volume-reuse chain,
 * with the dataset GUIDs that evidence recorded. Never searched by tag or pool
 * name. A broken chain fails closed rather than reading as a blank history.
 * `staged` and `ready` hold only for this deployment's own evidence, because a
 * previous deployment's pool was unmounted and exported before the handoff.
 */
export async function pool(root: Dir, deployment: Deployment): Promise<RecordedPool | null> {
  for await (const link of chain(root, deployment)) {
    const record = await evidence(root, link)
    if (record?.pool) {
      const own = link.id === deployment.id
      return {
        name: record.pool.name,
        guid: record.pool.guid,
        datasets: record.pool.datasets,
        deployment: link.id,
        staged: own && staged(record),
        ready: own && prepared(record),
      }
    }
  }
  return null
}
