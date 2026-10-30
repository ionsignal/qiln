import { InstallerError } from '../../diagnostic/error'
import { dataVolumeId } from './topology'
import * as deployments from './records'
import type { Dir } from '../../state/files'
import type { Deployment } from './types'

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_STATE_INVALID',
  })
}

/**
 * Walks the explicit volume-reuse chain from a deployment back to the one that
 * created its data volume, newest first. Never searched by tag, name, or time.
 * A cycle, a missing predecessor, or a hop whose previous deployment does not
 * hold the volume it was handed fails closed rather than reading as a blank
 * history.
 */
export async function* chain(root: Dir, start: Deployment): AsyncGenerator<Deployment> {
  const visited = new Set<string>()
  let current = start
  while (true) {
    if (visited.has(current.id)) {
      return invalid()
    }
    visited.add(current.id)
    yield current
    const { volume } = current.approval.host
    if (volume.kind === 'new') {
      return
    }
    const previous = await deployments.read(root, volume.from)
    if (previous === null || dataVolumeId(previous) !== volume.volumeId) {
      return invalid()
    }
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
