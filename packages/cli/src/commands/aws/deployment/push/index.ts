import { InstallerError, type DiagnosticFact } from '../../../../diagnostic/error'
import { requireAwsHost } from '../../../../aws/host'
import { runBaseline, unmetChecks } from '../../../../guest/baseline'
import { withArchive, type Archive } from '../../../../source/archive'
import { selectSource } from '../../../../source/select'
import { Prompts, withCancellation } from '../../../../terminal/prompts'
import { withConfirmedOperation } from '../../shared'
import { openAccess, withRemote } from '../access'
import { openTarget } from '../shared'
import { mib, reportPush } from './preview'
import * as deliver from '../../../../guest/deliver'
import type { AwsDeploymentPushOptions } from '../../../../input'
import type { Remote } from '../../../../ssh/connections'
import type { Reporter } from '../../../../terminal/reporter'

/**
 * Delivery starts only from a guest whose baseline passed. Every check is
 * shown, and nothing is written on the guest when one is not met.
 */
async function requireBaseline(
  reporter: Reporter,
  remote: Remote,
  account: string,
  deploymentId: string,
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
        ['Delivery', 'nothing was uploaded or written on the guest'],
      ],
      retry: `qiln aws deployment verify --id ${deploymentId}`,
    })
  }
}

async function transfer(
  reporter: Reporter,
  remote: Remote,
  archive: Archive,
  destination: deliver.Destination,
): Promise<void> {
  await deliver.tools(remote, destination)
  reporter.row('verified', 'Guest tools', 'tar, gzip, sha256sum, and stat are present')
  await deliver.prepare(remote, destination)
  reporter.row('created', 'Attempt', `${destination.directory} · fresh directory with an empty source/`)
  reporter.row('working', 'Uploading', `${mib(archive.bytes)} MiB to ${destination.archive}`)
  await deliver.upload(remote, destination, archive, sent =>
    reporter.info(`Upload in progress · ${mib(sent)} of ${mib(archive.bytes)} MiB sent.`),
  )
  reporter.row('transferred', 'Archive', 'sent exclusively; the bytes sent match the approved SHA-256')
  await deliver.digest(remote, destination, archive)
  reporter.row('verified', 'Remote digest', 'the archive on the guest matches the approved SHA-256')
  await deliver.extract(remote, destination)
  reporter.row('created', 'Source', `${destination.source} · extracted without sudo`)
}

/**
 * Delivers the working tree of the invoking directory to a fresh directory on
 * the recorded host. It installs, builds, starts, and activates nothing, and
 * it never replays, resumes, or deletes remote work.
 */
export async function push(options: AwsDeploymentPushOptions, reporter: Reporter): Promise<void> {
  if (options.source === 'release') {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_RELEASE_UNAVAILABLE',
    })
  }
  requireAwsHost()
  const { selector } = options
  const directory = process.cwd()
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment push --${selector.kind} ${selector.value}`, reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, selector)
      const { record } = target
      // The pin is resolved before packaging, so its wait never lands after approval.
      const access = await openAccess(root, target, `qiln aws deployment push --id ${record.id}`, reporter, signal)
      const selection = await selectSource(directory, signal)
      return await withArchive(directory, selection, signal, async archive => {
        const destination = deliver.fresh()
        reportPush(reporter, { access, selection, archive, destination })
        await prompts.approve('Deliver the displayed source to the deployment host')
        const { host, port, username, fingerprint } = access.options
        reporter.section('Guest baseline')
        reporter.row('working', 'Connecting', `${username}@${host}:${port} · pinned host key SHA256:${fingerprint}`)
        await withRemote(root, access, signal, async remote => {
          await requireBaseline(reporter, remote, username, record.id)
          reporter.section('Source delivery')
          await transfer(reporter, remote, archive, destination)
        })
        reporter.space()
        reporter.info(
          'The extracted source has no .git directory and is not a Git checkout. Nothing was installed, built, started, or activated.',
        )
        return `Source delivered to ${destination.source}. This is not host preparation, an installation, or runtime readiness.`
      })
    })
  })
  reporter.summary(message)
}
