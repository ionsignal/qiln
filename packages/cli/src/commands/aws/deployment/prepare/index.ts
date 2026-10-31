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
import { withConfirmedOperation } from '../../../../aws/operation'
import { approvalLabel as incusApproval, reportPlan as reportIncusPlan } from './incus'
import { approvalLabel as zfsApproval, reportPlan as reportZfsPlan } from './zfs'
import * as incusLineage from '../../../../aws/deployment/lineage/incus'
import * as lineage from '../../../../aws/deployment/lineage/zfs'
import type { AwsDeploymentOptions } from '../../../../input'
import type { Reporter } from '../../../../terminal/reporter'

/**
 * Plans preparation of the recorded data volume and the Incus installation on
 * it, in four phases, and applies each plan only after a default-no approval of
 * each displayed plan. First the ZFS prerequisites. Then the Incus software,
 * while no pool is mounted and the host is closed: persistent masks, the
 * repository, and the exact packages, so no package is ever installed against
 * mounted Incus state. Then the ZFS storage: one single-disk pool, created on a
 * blank volume or imported by its recorded GUID, together with its packaged
 * monthly scrub timer, and the mount of its state dataset. Last, the Incus
 * activation, each stage from a fresh inspection: the storage-identity guard, an
 * explicit open of the daemon on the mounted state dataset, and finally the
 * administrator account's membership in the Incus administration group. A fresh
 * installation opens an empty state directory and is followed by one
 * initialization from a retained preseed that registers the pool's `incus`
 * dataset and the bridge. A volume whose earlier deployment established and
 * released an installation instead installs the recorded package versions and
 * reopens that preserved installation, and never initializes. The local writes
 * are the host-key pin, retained before connecting exactly as for verify, and
 * the retained ZFS and Incus preparation evidence.
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
      const preserved = await incusLineage.retained(root, record)
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
        const zfsSoftware = await zfsPreparer.run(signal, 'software')
        reporter.section('Incus software inspection')
        reporter.row('working', 'Inspecting', 'fixed host and package inspection; no pool is mounted and no daemon is started')
        const incusSoftware = await incusPreparer.prepareSoftware({ account: username, retained: preserved }, signal)
        reporter.section('ZFS storage inspection')
        reporter.row('working', 'Inspecting', 'fixed read-only host and storage inspection')
        const zfsStorage = await zfsPreparer.run(signal, 'storage')
        const pool = await lineage.pool(root, record)
        if (pool === null || !pool.ready || pool.datasets === null) {
          throw new InstallerError({
            code: 'AWS_INCUS_PLAN_REFUSED',
            facts: [
              [
                'Reason',
                'The recorded ZFS pool is not verified imported with its scrub timer, its recorded datasets, and its state dataset mounted, so Incus is not planned.',
              ],
            ],
            retry,
          })
        }
        reporter.section('Incus activation inspection')
        reporter.row('working', 'Inspecting', 'fixed host, package, and Incus inspection')
        const incusActivation = await incusPreparer.activate(
          { pool: pool.name, guid: pool.guid, datasets: pool.datasets, account: username, retained: preserved },
          signal,
        )
        const applied = zfsSoftware + incusSoftware + zfsStorage + incusActivation
        const changed =
          applied === 0
            ? 'Nothing was changed.'
            : `${applied} approved ${applied === 1 ? 'step was' : 'steps were'} applied and verified by fresh inspection.`
        const reopened = preserved !== null && preserved.origin !== record.id
        const daemon = reopened
          ? 'the preserved Incus installation reopened without initialization and left with its instances stopped'
          : 'the opened daemon with its local Unix-socket access'
        const limits = reopened
          ? 'Qiln is not installed; the preserved instances were not started, and installation handoff and runtime readiness are not established.'
          : 'Qiln is not installed; restoration and runtime readiness are not established.'
        return `Incus baseline prepared: the persistent masks, the ${reopened ? 'recorded' : 'approved'} packages installed before the state dataset was mounted, the startup guard, ${daemon}, the recorded ZFS pool with its incus storage dataset, the bridge, and ${username}'s membership in the Incus administration group were verified as observed. The default profile was left untouched, and instances and images were not part of this check. ${changed} Group membership applies to new SSH connections only, and SSH forwarding to the Incus socket was not tested. The pool is a single disk with no redundancy or backup. ${limits}`
      })
    })
  })
  reporter.summary(message)
}
