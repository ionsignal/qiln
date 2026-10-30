import { observe } from '../../installation/observe'
import { refusal, requireAssignable, requireMatching } from '../../installation/assignment'
import { requireIncusExtensions } from '../../installation/preflight/incus'
import { invalidRecord, requireInputs, sameHost, type AwsBinding, type InstallationRecord } from '../../installation/records'
import {
  acquireInstallationLock,
  assignHost,
  listInstallations,
  readInstallation,
  type InstallationState,
} from '../../installation/state'
import { Prompts } from '../../terminal/prompts'
import { describeHost } from './host'
import * as journal from '../../installation/journal/records'
import type { InstallationInputs } from '../../installation/types'
import type { AwsHost } from '../../installation/target/aws/host'
import type { InstallationTarget } from '../../installation/target/types'
import type { Reporter } from '../../terminal/reporter'

const NOTICE =
  'Approval authorizes only recording the displayed deployment as the current host of the installation, as one atomic local record write that keeps the superseded host in the history. ' +
  'The retained handoff, release, export, and identity evidence and one fresh observation through the pinned connection were checked, and both are checked again after approval. ' +
  'Reassignment changes no Incus resource, replaces no image, rotates no credential, and starts no workload, and it never repairs or completes a configuration. ' +
  'It does not establish that the retained workloads work, and retention is not a backup. ' +
  'If the write is uncertain the command stops: read installation status before trying again.'

function reportProposal(reporter: Reporter, installation: InstallationState, host: AwsBinding): void {
  reporter.section('Proposed host reassignment (applied only after approval)')
  reporter.facts([
    ['Installation', installation.name],
    ['Current host', describeHost(installation.host)],
    ['Proposed host', describeHost(host)],
    [
      'Unchanged',
      `image pin ${installation.imageFingerprint} · ${installation.architecture} · checkout ${installation.checkoutPath} · retained credentials and configuration evidence`,
    ],
    [
      'Validated',
      'volume handoff, Incus release, ZFS export, and removal of every earlier deployment · the same Incus server identity, retained preseed, and ZFS pool · the checkout at the recorded path · a live installation that needs no change',
    ],
    ['Effect', 'one atomic write of the installation record; no Incus change and no workload start'],
  ])
  reporter.space()
  reporter.notice(NOTICE)
}

/**
 * Moves the stable installation to the selected deployment after a default-no
 * approval. The AWS lock is held by the target, and the installation lock is
 * held from validation until the record is written. Validation runs before and
 * after approval, and planning is used only as a predicate, so nothing here
 * mutates Incus.
 */
export async function reassign(target: InstallationTarget, aws: AwsHost, reporter: Reporter): Promise<void> {
  const { name, retry, signal } = target
  reporter.section('Preflight')
  const message = await target.withHost(reporter, retry.reassign, async host => {
    const entry = (await listInstallations(retry.reassign)).find(item => item.name === name)
    if (entry === undefined) {
      throw refusal(name, 'No installation is registered for this retained volume, so there is nothing to reassign.', retry.reassign)
    }
    const { directory } = entry
    const load = async (): Promise<InstallationRecord> => {
      const record = await readInstallation(directory, retry.inspect)
      if (record === null) {
        throw invalidRecord('installation.json is absent from a registered installation.', retry.inspect)
      }
      return record
    }
    const validate = async (record: InstallationRecord): Promise<InstallationState> => {
      const installation = requireAssignable(
        record,
        await journal.read(directory, record, retry.inspect),
        await aws.links(),
        retry.reassign,
      )
      const inputs: InstallationInputs = {
        architecture: host.architecture,
        layout: host.layout,
        sourceRoot: await host.checkout(record.checkoutPath),
      }
      requireInputs(record, inputs, retry.reassign)
      await host.withIncus(async incus => {
        requireIncusExtensions(incus.extensions, retry.inspect)
        await incus.verifyLayout()
        const observation = await observe({
          client: incus.client,
          directory,
          sshKeygen: host.sshKeygen,
          source: { kind: 'reference', selector: installation.imageFingerprint },
          installation,
          inputs,
          retry,
        })
        requireMatching(observation, { inputs, roster: null, retry }, name, retry.reassign)
      })
      return installation
    }
    const lock = await acquireInstallationLock(directory, retry.reassign)
    try {
      const assigned = await load()
      if (sameHost(assigned.host, aws.host)) {
        return 'The installation is already assigned to this deployment. Nothing was changed.'
      }
      reportProposal(reporter, await validate(assigned), aws.host)
      await new Prompts(signal, retry.reassign, reporter).approve(
        'Record the displayed deployment as the current host of the installation',
      )
      await assignHost(directory, await validate(await load()), aws.host, retry.inspect)
      return 'Installation host assignment recorded. No Incus resource, credential, or workload was changed, and workload correctness is not established.'
    } finally {
      await lock.release()
    }
  })
  reporter.summary(message)
}
