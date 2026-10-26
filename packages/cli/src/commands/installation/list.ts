import { listInstallations } from '../../install/state'
import type { Reporter, TableCell } from '../../terminal/reporter'

export async function list(reporter: Reporter): Promise<void> {
  const entries = await listInstallations('qiln installation list')
  reporter.section('Installations (recorded)')
  if (entries.length === 0) {
    reporter.info('No installation is registered.')
  } else {
    reporter.table(
      ['Name', 'Host', 'Architecture', 'Image pin'],
      entries.map(({ name, record }): TableCell[] => [
        name,
        record.host.kind,
        record.architecture,
        record.imageFingerprint?.slice(0, 12) ?? 'none',
      ]),
    )
    reporter.space()
    reporter.info('Select an installation with --local, or an AWS deployment with --alias or --id.')
  }
  reporter.info('This list reads local evidence only. It did not contact any target or authenticate to AWS.')
  reporter.summary(
    entries.length === 0
      ? 'No installations are recorded. No target was checked.'
      : `${entries.length} recorded ${entries.length === 1 ? 'installation' : 'installations'}. No target was checked.`,
  )
}
