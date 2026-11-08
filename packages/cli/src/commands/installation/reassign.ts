import { describeHost } from './host'
import { observe } from '../../installation/observe'
import { Prompts } from '../../terminal/prompts'
import { reportApproval } from '../../terminal/approval'
import { rootOf } from '../../installation/checkout/judge'
import { requireIncusExtensions } from '../../installation/preflight/incus'
import { refusal, requireAssignable, requireMatching } from '../../installation/assignment'
import { inputsOf } from '../../installation/types'
import { invalidRecord, requireInputs, sameHost, type AwsBinding, type InstallationRecord } from '../../installation/records'
import {
  acquireInstallationLock,
  assignHost,
  listInstallations,
  readInstallation,
  type InstallationState,
} from '../../installation/state'
import * as journal from '../../installation/journal/records'
import type { AwsHost } from '../../installation/target/aws/host'
import type { InstallationTarget } from '../../installation/target/types'
import type { Reporter } from '../../terminal/reporter'

function reportProposal(reporter: Reporter, installation: InstallationState, host: AwsBinding): void {
  reportApproval(
    reporter,
    {
      title: 'Proposed host reassignment',
      steps: [
        {
          label: 'Record the deployment as the current host',
          detail: `${describeHost(installation.host)} → ${describeHost(host)} · the superseded host stays in the history`,
        },
      ],
      covers:
        'One atomic write of the installation record. The retained evidence and the live installation are checked again after approval.',
      stays: `Image pin ${installation.imageFingerprint} · ${installation.architecture} · checkout ${installation.checkoutPath} · restore point ${installation.checkoutCommit ?? 'none'}, and every Incus resource, credential, image, and workload.`,
      lasting: 'Retention is not a backup. If the write is uncertain, read installation status before trying again.',
      notEstablished: 'Workload correctness.',
    },
    {
      label: 'Validated',
      detail:
        'volume handoff, Incus release, ZFS export, and removal of every earlier deployment · the same Incus server identity, retained preseed, and ZFS pool · a live installation that needs no change (the managed checkout may be absent, and published port devices are reconciled by the next configure)',
    },
  )
}

/**
 * Moves the stable installation to the selected deployment after a default-no
 * approval. The AWS lock is held by the target, and the installation lock is
 * held from validation until the record is written. Validation runs before and
 * after approval, and planning is used only as a predicate, so nothing here
 * mutates Incus. The recheck after approval is silent, because a disagreement
 * throws a diagnostic instead of printing.
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
      const inputs = inputsOf(host, await rootOf(host.checkout, record.checkoutPath, retry.reassign))
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
          checkoutCommit: installation.checkoutCommit,
          checkout: host.checkout,
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
      const proposed = await validate(assigned)
      reportProposal(reporter, proposed, aws.host)
      await new Prompts(signal, retry.reassign, reporter).approve('Record this deployment as the installation host')
      const confirmed = await reporter.silent(async () => await validate(await load()))
      reporter.section('Recording')
      await assignHost(directory, confirmed, aws.host, retry.inspect)
      reporter.row(
        'transferred',
        'Host assignment',
        `${describeHost(aws.host)} recorded as the current host · ${describeHost(confirmed.host)} kept in the history`,
      )
      return 'Installation host assignment recorded. No Incus resource, credential, or workload was changed, and workload correctness is not established.'
    } finally {
      await lock.release()
    }
  })
  reporter.summary(message)
}
