import { requireAwsHost } from '../../../aws/host'
import { openAwsRoot } from '../../../aws/root'
import { notFound } from './shared'
import {
  recordedState,
  reportDeployment,
  reportIncus,
  reportIncusUnreadable,
  reportZfs,
  reportZfsUnreadable,
} from './report'
import * as deployments from '../../../aws/deployment/records'
import * as incus from '../../../aws/deployment/incus/evidence'
import * as lineage from '../../../aws/deployment/zfs/lineage'
import type { Deployment } from '../../../aws/deployment/types'
import type { AwsDeploymentOptions } from '../../../input'
import type { Dir } from '../../../state/files'
import type { Reporter } from '../../../terminal/reporter'

/**
 * Unreadable preparation evidence degrades to a notice, independently for ZFS
 * and Incus, so readable AWS evidence stays visible.
 */
async function reportPreparation(reporter: Reporter, root: Dir, record: Deployment): Promise<void> {
  try {
    reportZfs(reporter, await lineage.evidence(root, record))
  } catch {
    reportZfsUnreadable(reporter)
  }
  try {
    reportIncus(reporter, await incus.evidence(root, record))
  } catch {
    reportIncusUnreadable(reporter)
  }
}

export async function status(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const root = await openAwsRoot()
  const record = root === null ? null : await deployments.find(root, options.selector)
  if (root === null || !record) {
    throw notFound(options.selector)
  }
  reportDeployment(reporter, record)
  await reportPreparation(reporter, root, record)
  reporter.info('This status reads local evidence only. It did not authenticate, call AWS, or freshly observe any AWS resource.')
  if (record.steps.length > 0) {
    reporter.info(`To retain a fresh observation, run: qiln aws deployment inspect --id ${record.id}`)
  }
  reporter.summary(`Recorded state: ${recordedState(record).label}.`)
}
