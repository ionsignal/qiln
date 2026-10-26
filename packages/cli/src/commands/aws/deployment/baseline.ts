import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { runBaseline, unmetChecks } from '../../../host/baseline'
import type { Remote } from '../../../transport/ssh/connections'
import type { Reporter } from '../../../terminal/reporter'

/**
 * Remote work starts only from a guest whose baseline passed. Every check is
 * shown, and `untouched` states what the calling command did not do.
 */
export async function requireBaseline(
  reporter: Reporter,
  remote: Remote,
  account: string,
  deploymentId: string,
  untouched: DiagnosticFact,
): Promise<void> {
  const checks = await runBaseline(remote, account)
  reporter.facts(checks.map((check): DiagnosticFact => [check.label, `${check.status} · ${check.detail}`]))
  const unmet = unmetChecks(checks)
  if (unmet.length > 0) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_VERIFY_FAILED',
      facts: [
        ['Deployment', deploymentId],
        ['Not passed', unmet.map(check => `${check.label} (${check.status})`).join(', ')],
        untouched,
      ],
      retry: `qiln aws deployment verify --id ${deploymentId}`,
    })
  }
}
