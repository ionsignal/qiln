import { requireAwsHost } from '../../../aws/host'
import { openAwsRoot } from '../../../aws/root'
import { notFound } from '../../../aws/deployment/volume/alias'
import { stageOf } from '../../../aws/deployment/handoff/stage'
import {
  recordedState,
  reportDeployment,
  reportHandoff,
  reportIncus,
  reportUnreadable,
  reportZfs,
} from './report'
import * as deployments from '../../../aws/deployment/records'
import * as incus from '../../../aws/deployment/incus/evidence'
import * as lineage from '../../../aws/deployment/lineage/zfs'
import type { Deployment } from '../../../aws/deployment/types'
import type { AwsDeploymentOptions } from '../../../input'
import type { Dir } from '../../../state/files'
import type { Reporter } from '../../../terminal/reporter'

/**
 * Both directions of the retained-volume hand-off: the deployment this one
 * took its volume from, and the one that reserved or took the volume from it.
 */
async function reportHandoffs(reporter: Reporter, root: Dir, record: Deployment): Promise<void> {
  const { volume } = record.approval.host
  if (volume.kind === 'reuse') {
    const previous = await deployments.read(root, volume.from)
    if (previous !== null) {
      reportHandoff(reporter, previous, record, stageOf(previous, record))
    }
  }
  if (record.successor !== null) {
    const replacement = await deployments.read(root, record.successor.to)
    reportHandoff(reporter, record, replacement, stageOf(record, replacement))
  }
}

/**
 * Unreadable evidence degrades to a notice, so readable AWS evidence stays
 * visible.
 */
async function reportEvidence(reporter: Reporter, label: string, report: () => Promise<void>): Promise<void> {
  try {
    await report()
  } catch {
    reportUnreadable(reporter, label)
  }
}

async function reportPreparation(reporter: Reporter, root: Dir, record: Deployment): Promise<void> {
  await reportEvidence(reporter, 'ZFS', async () => reportZfs(reporter, await lineage.evidence(root, record)))
  await reportEvidence(reporter, 'Incus', async () => reportIncus(reporter, await incus.evidence(root, record)))
}

export async function status(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const root = await openAwsRoot()
  if (root === null) {
    throw notFound(options.selector)
  }
  const record = await deployments.select(root, options.selector)
  reporter.space()
  reportDeployment(reporter, record)
  await reportHandoffs(reporter, root, record)
  await reportPreparation(reporter, root, record)
  reporter.space()
  reporter.info('This status reads local evidence only. It did not authenticate, call AWS, or freshly observe any AWS resource.')
  if (record.steps.length > 0) {
    reporter.info(`To retain a fresh observation, run: qiln aws deployment inspect --id ${record.id}`)
  }
  reporter.summary(`Recorded state: ${recordedState(record).label}.`)
}
