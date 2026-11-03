import * as deployments from '../records'
import * as records from './records'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'
import type { IncusRecord } from './types'

/**
 * Separate from `records.ts` to avoid an import cycle: the deployment records
 * import that module for the reuse guard.
 */
export async function evidence(root: Dir, deployment: Deployment): Promise<IncusRecord | null> {
  return await records.read(await deployments.directoryOf(root, deployment.id), deployment)
}
