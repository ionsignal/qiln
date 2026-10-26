import { INSTALLER_SPEC } from '../../install/spec'
import { awsInstallationName } from '../../install/aws'
import { unsettled } from '../../install/journal/facts'
import { listInstallations } from '../../install/state'
import { stateOf } from '../../journal/step'
import { selectorFlags } from '../../retry'
import * as journal from '../../install/journal/records'
import type { HostBinding } from '../../install/records'
import type { Reporter } from '../../terminal/reporter'
import type { InstallationSelector } from './target'

function describeHost(host: HostBinding): string {
  return host.kind === 'local' ? 'this machine' : `AWS deployment ${host.deployment} · instance ${host.instanceId}`
}

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
    ['Architecture', record.architecture],
    ['Checkout', record.checkoutPath],
    ['Image pin', record.imageFingerprint ?? 'none'],
    ['Authorizations', String(evidence?.authorizations.length ?? 0)],
    ['Recorded steps', String(evidence?.steps.length ?? 0)],
    ['Unresolved steps', open.length === 0 ? 'none' : open.map(step => `${step.action} (${stateOf(step)})`).join(', ')],
  ])
  if (open.length > 0) {
    reporter.space()
    reporter.notice(
      'An unresolved step blocks configuration. Interrupted work may already have completed, and nothing was replayed, resumed, or rolled back.',
    )
  }
  reporter.info('This status reads local evidence only. It did not contact the target, authenticate to AWS, or take a lock.')
  reporter.summary(`Installation '${name}' is recorded. Its live state was not observed.`)
}
