import { invalidDeployment } from '../ledger/invalid'
import { requireIntact } from '../handoff/stage'
import { dataVolumeId } from '../topology'
import * as deployments from '../records'
import type { Deployment } from '../types'
import type { Dir } from '../../../state/files'

/**
 * Walks the explicit volume-reuse chain from a deployment back to the one that
 * created its data volume, newest first. Never searched by tag, name, or time.
 * A cycle, a missing predecessor, or a hop whose previous deployment does not
 * hold the volume it was handed fails closed rather than reading as a blank
 * history. A hop whose reservation and replacement contradict each other fails
 * closed with the pending hand-off diagnostic, while a reservation that is
 * merely in progress is a valid link.
 */
export async function* chain(root: Dir, start: Deployment): AsyncGenerator<Deployment> {
  const visited = new Set<string>()
  let current = start
  while (true) {
    if (visited.has(current.id)) {
      return invalidDeployment()
    }
    visited.add(current.id)
    yield current
    const { volume } = current.approval.host
    if (volume.kind === 'new') {
      return
    }
    const previous = await deployments.read(root, volume.from)
    if (previous === null || dataVolumeId(previous) !== volume.volumeId) {
      return invalidDeployment()
    }
    requireIntact(previous, current)
    current = previous
  }
}

/**
 * The ID of the deployment that created the data volume of the chain. It never
 * changes when the volume moves to a later deployment, so it names whatever is
 * kept across host replacements.
 */
export async function originOf(root: Dir, start: Deployment): Promise<string> {
  let origin = start.id
  for await (const link of chain(root, start)) {
    origin = link.id
  }
  return origin
}
