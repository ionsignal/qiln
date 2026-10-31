import { deploymentName } from '../../../aws/deployment/volume/alias'
import { verification, type Verification } from '../../../aws/deployment/observe/facts'
import * as deployments from '../../../aws/deployment/records'
import { requireAwsHost } from '../../../aws/host'
import { openAwsRoot } from '../../../aws/root'
import type { Reporter, TableCell } from '../../../terminal/reporter'
import { recordedState } from './report'

const VERIFICATION_CELLS: Record<Verification, TableCell> = {
  verified: { text: 'Verified', tone: 'success' },
  'not-verified': { text: 'Not verified', tone: 'neutral' },
  uncertain: { text: 'Uncertain', tone: 'danger' },
}

export async function list(reporter: Reporter): Promise<void> {
  requireAwsHost()
  const root = await openAwsRoot()
  const records = root === null ? [] : (await deployments.list(root)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  reporter.section('Deployments (recorded)')
  if (records.length === 0) {
    reporter.info('No deployment evidence is retained.')
  } else {
    reporter.table(
      ['Name', 'ID', 'Recorded state', 'Recorded verification'],
      records.map((record): TableCell[] => {
        const state = recordedState(record)
        return [
          deploymentName(record.alias),
          record.id,
          { text: state.label, tone: state.tone },
          VERIFICATION_CELLS[verification(record)],
        ]
      }),
    )
    reporter.space()
    reporter.info('Select a deployment with --alias (the part after qiln-) or --id.')
  }
  reporter.info('This list reads local evidence only. It did not authenticate, call AWS, or freshly observe any AWS resource.')
  reporter.summary(
    records.length === 0
      ? 'No deployments are recorded. AWS was not checked.'
      : `${records.length} recorded ${records.length === 1 ? 'deployment' : 'deployments'}. AWS was not checked.`,
  )
}
