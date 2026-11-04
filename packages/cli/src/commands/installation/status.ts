import { INSTALLER_SPEC } from '../../installation/spec'
import { describeHost } from './host'
import { stateOf } from '../../journal/step'
import { unsettled } from '../../installation/journal/facts'
import { listInstallations } from '../../installation/state'
import { selectorFlags } from '../../installation/retry'
import { awsInstallationName } from '../../installation/target/aws/host'
import * as journal from '../../installation/journal/records'
import type { Reporter } from '../../terminal/reporter'
import type { InstallationSelector } from '../../installation/target/types'

/**
 * Reports retained evidence only. It connects to no target, authenticates to
 * nothing, and takes no lock, so it also works while another operation runs.
 */
export async function status(selector: InstallationSelector, reporter: Reporter): Promise<void> {
  const retry = `qiln installation status ${selectorFlags(selector)}`
  const name = selector.kind === 'local' ? INSTALLER_SPEC.state.localName : await awsInstallationName(selector)
  const entry = (await listInstallations(retry)).find(item => item.name === name)
  reporter.section('Installation (recorded)')
  if (entry === undefined) {
    reporter.info(`No installation named '${name}' is registered. Nothing was created.`)
    reporter.summary('No installation is recorded for this target. The target was not contacted.')
    return
  }
  const { record } = entry
  const evidence = await journal.read(entry.directory, record, retry)
  const open = unsettled(evidence)
  reporter.facts([
    ['Installation', record.name],
    ['Host', describeHost(record.host)],
    [
      'Previous hosts',
      record.history.length === 0
        ? 'none'
        : record.history.map(entry => `${describeHost(entry.host)} (until ${entry.reassignedAt})`).join(', '),
    ],
    ['Architecture', record.architecture],
    ['Checkout', record.checkoutPath],
    [
      'Restore point',
      record.host.kind === 'aws'
        ? `${record.checkoutCommit ?? 'none yet'} · the commit that configure restores when the managed checkout is absent; not a statement about the running tree`
        : 'not managed; the checkout is the operator’s own',
    ],
    ['Image pin', record.imageFingerprint ?? 'none'],
    ['Authorizations', String(evidence?.authorizations.length ?? 0)],
    ['Recorded steps', String(evidence?.steps.length ?? 0)],
    ['Unresolved steps', open.length === 0 ? 'none' : open.map(step => `${step.action} (${stateOf(step)})`).join(', ')],
  ])
  if (open.length > 0) {
    reporter.notice(
      'An unresolved step blocks configuration. Interrupted work may already have completed, and nothing was replayed, resumed, or rolled back.',
    )
  }
  reporter.info('This status reads local evidence only. It did not contact the target, authenticate to AWS, or take a lock.')
  reporter.summary(`Installation '${name}' is recorded. Its live state was not observed.`)
}
