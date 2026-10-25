import * as deployments from '../records'
import * as records from './records'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../types'
import type { IncusRecord } from './types'

/**
 * Kept apart from `records.ts` because the deployment records import that
 * module for the reuse guard, and this one imports the deployment records.
 */
export async function evidence(root: Dir, deployment: Deployment): Promise<IncusRecord | null> {
  return await records.read(await deployments.directoryOf(root, deployment.id), deployment)
}
