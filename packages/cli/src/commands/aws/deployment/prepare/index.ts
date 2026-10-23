import { openTarget } from '../shared'
import { approvalLabel, reportPlan } from './preview'
import { requireBaseline } from '../baseline'
import { openAccess, withRemote } from '../access'
import { progressSink } from '../progress'
import { InstallerError } from '../../../../diagnostic/error'
import { requireAwsHost } from '../../../../aws/host'
import { targetOf } from '../../../../aws/deployment/zfs/target'
import { requireNotStuck } from '../../../../aws/deployment/zfs/facts'
import { Preparer } from '../../../../aws/deployment/zfs/prepare'
import { Prompts, withCancellation } from '../../../../terminal/prompts'
import { withConfirmedOperation } from '../../shared'
import * as lineage from '../../../../aws/deployment/zfs/lineage'
import type { AwsDeploymentOptions } from '../../../../input'
import type { Reporter } from '../../../../terminal/reporter'

/**
 * Plans ZFS preparation of the recorded data volume and applies it only after
 * a default-no approval of each displayed plan: first the prerequisites, then
 * one single-disk pool, created on a blank volume or imported by its recorded
 * GUID, together with its packaged monthly scrub timer. The local writes are
 * the host-key pin, retained before connecting exactly as for verify and push,
 * and the retained ZFS preparation evidence.
 */
export async function prepare(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const { selector } = options
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment prepare --${selector.kind} ${selector.value}`, reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const deployment = await openTarget(root, store, selector)
      const { record } = deployment
      const retry = `qiln aws deployment prepare --id ${record.id}`
      requireNotStuck(await lineage.evidence(root, record), record.id)
      const access = await openAccess(root, deployment, retry, reporter, signal)
      const target = targetOf(record)
      if (target === null) {
        throw new InstallerError({
          code: 'INTERNAL_ERROR',
          retry,
        })
      }
      const recorded = await lineage.pool(root, record)
      const { host, port, username, fingerprint } = access.options
      reporter.section('Guest baseline')
      reporter.row('working', 'Connecting', `${username}@${host}:${port} · pinned host key SHA256:${fingerprint}`)
      return await withRemote(root, access, signal, async remote => {
        await requireBaseline(reporter, remote, username, record.id, [
          'Preparation',
          'no ZFS inspection was performed',
        ])
        reporter.section('ZFS inspection')
        reporter.row('working', 'Inspecting', 'fixed read-only host and storage inspection')
        const preparer = await Preparer.open({
          root,
          deployment: record,
          target,
          recorded,
          remote,
          hooks: {
            show: (observation, plan) => reportPlan(reporter, { observation, plan, target }),
            approve: plan => prompts.approve(approvalLabel(plan)),
            progress: progressSink(reporter),
          },
        })
        const applied = await preparer.run(signal)
        const changed =
          applied === 0
            ? 'Nothing was changed.'
            : `${applied} approved ${applied === 1 ? 'step was' : 'steps were'} applied and verified by fresh inspection.`
        return `The ZFS pool is imported on the recorded data volume and its packaged monthly scrub timer is enabled, as observed. ${changed} The pool is a single disk with no redundancy or backup. This is not a prepared host, Incus, a Qiln installation, or runtime readiness.`
      })
    })
  })
  reporter.summary(message)
}
