import { deploymentName } from '../../../aws/deployment/alias'
import { effects } from '../../../aws/deployment/facts'
import * as deployments from '../../../aws/deployment/records'
import { requireAwsHost } from '../../../aws/host'
import { openAwsRoot } from '../../../aws/root'
import type { Reporter, TableCell } from '../../../terminal/reporter'
import { recordedState } from './report'

export async function list(reporter: Reporter): Promise<void> {
  requireAwsHost()
  const root = await openAwsRoot()
  const records = root === null ? [] : (await deployments.list(root)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  reporter.section('Deployments (recorded)')
  if (records.length === 0) {
    reporter.info('No deployment evidence is retained.')
  } else {
    reporter.table(
      ['Name', 'ID', 'Recorded state', 'Outstanding effects'],
      records.map((record): TableCell[] => {
        const state = recordedState(record)
        return [
          deploymentName(record.alias),
          record.id,
          { text: state.label, tone: state.tone },
          effects(record) === 'outstanding' ? { text: 'outstanding', tone: 'warning' } : 'none',
        ]
      }),
    )
    reporter.space()
    reporter.info('Select a deployment with --alias (the part after qiln-) or --id.')
  }
  reporter.info('This list read local evidence only. It did not authenticate, call AWS, or freshly observe any network.')
  reporter.summary(
    records.length === 0
      ? 'No deployments are recorded.'
      : `${records.length} recorded ${records.length === 1 ? 'deployment' : 'deployments'}.`,
  )
}
