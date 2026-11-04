import { InstallerError } from '../../../diagnostic/error'
import { requireAwsHost } from '../../../aws/host'
import { runBaseline, unmetChecks } from '../../../host/baseline'
import { withCancellation } from '../../../terminal/prompts'
import { withConfirmedOperation } from '../../../aws/operation'
import { resolveAccess, withRemote } from './access'
import { reportChecks, unmetFact } from './baseline'
import { openTarget } from './shared'
import type { AwsDeploymentOptions } from '../../../input'
import type { Reporter } from '../../../terminal/reporter'

/**
 * Runs fixed read-only probes over the pinned, key-authenticated connection.
 * Nothing is installed, written, or retained on the guest, and no verification
 * record is kept. Only a missing host-key pin is retained, before connecting.
 */
export async function verify(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const message = await withCancellation(async signal => {
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, options.selector)
      const { record } = target
      const retry = `qiln aws deployment verify --id ${record.id}`
      const access = await resolveAccess(root, target, retry, reporter, signal)
      const { username } = access.options
      const checks = await withRemote(root, access, signal, remote => runBaseline(remote, username))
      reporter.section('Guest baseline')
      reportChecks(reporter, checks)
      reporter.info(
        'Verification is read-only. Nothing was installed, written, or retained on the guest. The host key is AWS-reported console evidence, not guest attestation, and the architecture is observed, never compared.',
      )
      const unmet = unmetChecks(checks)
      if (unmet.length > 0) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_VERIFY_FAILED',
          facts: [['Deployment', record.id], unmetFact(unmet)],
          retry,
        })
      }
      return 'Guest baseline verified. This is not host preparation, storage eligibility, effective sshd settings, or runtime readiness.'
    })
  })
  reporter.summary(message)
}
