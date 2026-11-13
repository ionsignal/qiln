import { hostRemoved } from '../../aws/deployment/topology'
import { openAwsRoot } from '../../aws/root'
import { listInstallations } from '../../installation/state'
import * as deployments from '../../aws/deployment/records'
import type { HostBinding } from '../../installation/records'
import type { Dir } from '../../state/files'
import type { Reporter, TableCell } from '../../terminal/reporter'

/**
 * An AWS installation is orphaned when the deployment assigned to it is no
 * longer recorded, or its host was removed or observed absent. This reads
 * retained evidence only, so it says nothing about the live target.
 */
async function isOrphaned(root: Dir | null, host: HostBinding): Promise<boolean> {
  if (host.kind !== 'aws') {
    return false
  }
  const deployment = root === null ? null : await deployments.read(root, host.deployment)
  return deployment === null || hostRemoved(deployment)
}

export async function list(reporter: Reporter): Promise<void> {
  const entries = await listInstallations('qiln installation list')
  const root = entries.some(({ record }) => record.host.kind === 'aws') ? await openAwsRoot() : null
  const orphans = new Set<string>()
  for (const { name, record } of entries) {
    if (await isOrphaned(root, record.host)) {
      orphans.add(name)
    }
  }
  reporter.section('Installations (recorded)')
  if (entries.length === 0) {
    reporter.info('No installation is registered.')
  } else {
    reporter.table(
      ['Name', 'Host', 'Architecture', 'Image pin'],
      entries.map(({ name, record }): TableCell[] => [
        name,
        orphans.has(name) ? { text: `${record.host.kind} (orphaned)`, tone: 'warning' } : record.host.kind,
        record.architecture,
        record.imageFingerprint?.slice(0, 12) ?? 'none',
      ]),
    )
    reporter.info('Select an installation with --local, or an AWS deployment with --alias or --id.')
  }
  reporter.info('This list reads local evidence only. It did not contact any target or authenticate to AWS.')
  if (orphans.size > 0) {
    reporter.notice(
      'The AWS host of an orphaned installation was removed, observed absent, or is no longer recorded, so it cannot be inspected or configured. Retained evidence stays readable with qiln installation status.',
    )
  }
  reporter.summary(
    entries.length === 0
      ? 'No installations are recorded. No target was checked.'
      : `${entries.length} recorded ${entries.length === 1 ? 'installation' : 'installations'}. No target was checked.`,
  )
}
