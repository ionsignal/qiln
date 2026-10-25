import { openTarget } from '../shared'
import { requireBaseline } from '../baseline'
import { resolveAccess, withRemote } from '../access'
import { progressSink } from '../progress'
import { InstallerError } from '../../../../diagnostic/error'
import { requireAwsHost } from '../../../../aws/host'
import { targetOf } from '../../../../aws/deployment/zfs/target'
import { requireNotStuck } from '../../../../aws/deployment/zfs/facts'
import { requireNotStuck as requireIncusNotStuck } from '../../../../aws/deployment/incus/facts'
import { evidence as incusEvidence } from '../../../../aws/deployment/incus/evidence'
import { IncusPreparer } from '../../../../aws/deployment/incus/prepare'
import { ZfsPreparer } from '../../../../aws/deployment/zfs/prepare'
import { Prompts, withCancellation } from '../../../../terminal/prompts'
import { withConfirmedOperation } from '../../shared'
import { approvalLabel as incusApproval, reportPlan as reportIncusPlan } from './incus'
import { approvalLabel as zfsApproval, reportPlan as reportZfsPlan } from './zfs'
import * as lineage from '../../../../aws/deployment/zfs/lineage'
import type { AwsDeploymentOptions } from '../../../../input'
import type { Reporter } from '../../../../terminal/reporter'

/**
 * Plans ZFS preparation of the recorded data volume and then Incus preparation
 * on the recorded pool, and applies each only after a default-no approval of
 * each displayed plan. ZFS first: the prerequisites, then one single-disk pool,
 * created on a blank volume or imported by its recorded GUID, together with its
 * packaged monthly scrub timer. Then Incus, each from a fresh inspection: the
 * repository, the exact packages, one initialization from a retained preseed,
 * and finally the administrator account's membership in the Incus
 * administration group. The local writes are the host-key pin, retained before
 * connecting exactly as for verify, and the retained ZFS and Incus preparation
 * evidence.
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
      requireIncusNotStuck(await incusEvidence(root, record), record.id)
      const access = await resolveAccess(root, deployment, retry, reporter, signal)
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
          'no ZFS or Incus inspection was performed',
        ])
        reporter.section('ZFS inspection')
        reporter.row('working', 'Inspecting', 'fixed read-only host and storage inspection')
        const zfsPreparer = await ZfsPreparer.open({
          root,
          deployment: record,
          target,
          recorded,
          remote,
          hooks: {
            show: (observation, plan) => reportZfsPlan(reporter, { observation, plan, target }),
            approve: plan => prompts.approve(zfsApproval(plan)),
            progress: progressSink(reporter),
          },
        })
        const incusPreparer = await IncusPreparer.open({
          root,
          deployment: record,
          remote,
          hooks: {
            show: (observation, plan) => reportIncusPlan(reporter, { observation, plan }),
            approve: plan => prompts.approve(incusApproval(plan)),
            progress: progressSink(reporter),
          },
        })
        const zfsApplied = await zfsPreparer.run(signal)
        const pool = await lineage.pool(root, record)
        if (pool === null || !pool.ready) {
          throw new InstallerError({
            code: 'AWS_INCUS_PLAN_REFUSED',
            facts: [
              [
                'Reason',
                'The recorded ZFS pool is not verified imported with its scrub timer, so Incus is not planned.',
              ],
            ],
            retry,
          })
        }
        reporter.section('Incus inspection')
        reporter.row('working', 'Inspecting', 'fixed host, package, and Incus inspection')
        const incusApplied = await incusPreparer.run({ pool: pool.name, guid: pool.guid, account: username }, signal)
        const applied = zfsApplied + incusApplied
        const changed =
          applied === 0
            ? 'Nothing was changed.'
            : `${applied} approved ${applied === 1 ? 'step was' : 'steps were'} applied and verified by fresh inspection.`
        return `Incus baseline prepared: the approved packages, daemon Unix-socket access, the recorded ZFS pool, the bridge, the default profile, and ${username}'s membership in the Incus administration group were verified as observed. Instances and images were not part of this check. ${changed} Group membership applies to new SSH connections only, and SSH forwarding to the Incus socket was not tested. The pool is a single disk with no redundancy or backup. Qiln is not installed; restoration and runtime readiness are not established.`
      })
    })
  })
  reporter.summary(message)
}
