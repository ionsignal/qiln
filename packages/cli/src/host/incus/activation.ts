import { SCRIPTS, sha256Of } from './recipe'
import { INCUS_SPEC } from './spec'
import { STATE_MOUNTPOINT } from '../mount'
import { datasetNamesOf, ZFS_SPEC } from '../zfs/spec'
import type { PoolTarget } from './types'

/**
 * One file of the storage-identity guard: the exact approved text, where it
 * lives on the host, and the digest of those bytes.
 */
export interface Artifact {
  path: string
  text: string
  sha256: string
}

export interface Guard {
  expectation: Artifact
  check: Artifact
  dropIn: Artifact
}

function artifact(path: string, text: string): Artifact {
  return { path, text, sha256: sha256Of(text) }
}

/**
 * Derives the three guard files from the recorded pool identities alone, so the
 * approved bytes are the bytes the host receives. The expectation file is
 * the identity the startup check compares with the kernel mount table, and the
 * drop-in makes that check the first thing the daemon service runs. It is an
 * `ExecCondition`, whose refusal fails the unit instead of skipping it, and it
 * runs before any other start command of the packaged unit.
 */
export function guardOf(target: PoolTarget): Guard {
  const { guard } = INCUS_SPEC
  const expectation =
    [
      `layout=${ZFS_SPEC.layout.revision}`,
      `pool=${target.pool}`,
      `poolGuid=${target.guid}`,
      `stateDataset=${datasetNamesOf(target.pool).state}`,
      `stateGuid=${target.datasets.state}`,
      `mountpoint=${STATE_MOUNTPOINT}`,
    ].join('\n') + '\n'
  const dropIn =
    ['# Managed by Qiln. Do not edit.', '[Service]', `ExecCondition=${guard.checkFile} ${guard.expectationFile}`].join(
      '\n',
    ) + '\n'
  return {
    expectation: artifact(guard.expectationFile, expectation),
    check: artifact(guard.checkFile, SCRIPTS.startup),
    dropIn: artifact(guard.dropInFile, dropIn),
  }
}
