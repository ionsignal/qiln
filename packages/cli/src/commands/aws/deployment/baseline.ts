import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { runBaseline, unmetChecks, type Check, type CheckStatus } from '../../../host/baseline'
import type { Remote } from '../../../transport/ssh/connections'
import type { Reporter, TableCell, Tone } from '../../../terminal/reporter'

const RESULTS: Record<CheckStatus, { text: string; tone: Tone }> = {
  passed: { text: 'Passed', tone: 'success' },
  failed: { text: 'Failed', tone: 'danger' },
  unverified: { text: 'Unverified', tone: 'warning' },
  observed: { text: 'Observed', tone: 'neutral' },
  'not-run': { text: 'Not run', tone: 'neutral' },
}

/**
 * The one rendering of guest baseline results. The caller owns the section
 * that it sits under.
 */
export function reportChecks(reporter: Reporter, checks: readonly Check[]): void {
  reporter.table(
    ['Check', 'Result', 'Detail'],
    checks.map((check): TableCell[] => [check.label, RESULTS[check.status], check.detail]),
  )
}

export function unmetFact(unmet: readonly Check[]): DiagnosticFact {
  return ['Not passed', unmet.map(check => `${check.label} (${RESULTS[check.status].text.toLowerCase()})`).join(', ')]
}

/**
 * Remote work starts only from a guest whose baseline passed. Every check is
 * shown under its own section, and `untouched` states what the calling command
 * did not do.
 */
export async function requireBaseline(
  reporter: Reporter,
  remote: Remote,
  account: string,
  deploymentId: string,
  untouched: DiagnosticFact,
): Promise<void> {
  reporter.section('Guest baseline')
  const checks = await runBaseline(remote, account)
  reportChecks(reporter, checks)
  const unmet = unmetChecks(checks)
  if (unmet.length > 0) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_VERIFY_FAILED',
      facts: [['Deployment', deploymentId], unmetFact(unmet), untouched],
      retry: `qiln aws deployment verify --id ${deploymentId}`,
    })
  }
}
