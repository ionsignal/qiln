import { openTarget } from '../shared'
import { requireBaseline } from '../baseline'
import { resolveAccess, withRemote } from '../access'
import { progressSink } from '../progress'
import { InstallerError } from '../../../../diagnostic/error'
import { requireAwsHost } from '../../../../aws/host'
import { targetOf } from '../../../../aws/deployment/zfs/target'
import { requireNotStuck } from '../../../../aws/deployment/zfs/facts'
import { Prompts, withCancellation } from '../../../../terminal/prompts'
import { IncusPreparer } from '../../../../aws/deployment/incus/prepare'
import { ZfsPreparer } from '../../../../aws/deployment/zfs/prepare'
import { withConfirmedOperation } from '../../../../aws/operation'
import { evidence as incusEvidence } from '../../../../aws/deployment/incus/evidence'
import { opened, requireNotStuck as requireIncusNotStuck } from '../../../../aws/deployment/incus/facts'
import { approvalLabel as incusApproval, reportPlan as reportIncusPlan } from './incus'
import { approvalLabel as zfsApproval, reportPlan as reportZfsPlan } from './zfs'
import { reportRun } from './steps'
import * as incusLineage from '../../../../aws/deployment/lineage/incus'
import * as lineage from '../../../../aws/deployment/lineage/zfs'
import type { AwsDeploymentOptions } from '../../../../input'
import type { Reporter } from '../../../../terminal/reporter'

/**
 * Plans preparation of the recorded data volume and the Incus installation on
 * it, in five phases, and applies each plan only after a default-no approval of
 * each displayed plan. First the Incus closing together with its repository:
 * persistent masks that are verified before any package effect, so neither ZFS
 * nor Incus package configuration runs against an open daemon, followed under
 * the same approval by the Zabbly repository files and a package-list refresh;
 * every refusal that offline evidence can decide is reached before the first
 * mask, a host that is already closed with its repository in place asks
 * nothing, and once Qiln opened Incus it is never closed again here. Then the
 * ZFS prerequisites, which are refused once Qiln has opened Incus, because a
 * package script could disturb the running daemon. Then the Incus packages,
 * while no pool is mounted and the host is closed: the exact packages, so no
 * package is ever installed against mounted Incus state. Then the ZFS storage:
 * one single-disk pool, created on a blank volume or imported by its recorded
 * GUID, together with its packaged monthly scrub timer, and the mount of its
 * state dataset. Last, the Incus activation, each stage from a fresh
 * inspection: the storage-identity guard, an explicit open of the daemon on the
 * mounted state dataset, and finally the administrator account's membership in
 * the Incus administration group. A fresh installation opens an empty state
 * directory and is followed by one initialization from a retained preseed that
 * registers the pool's `incus` dataset and the bridge. A volume whose earlier
 * deployment established and released an installation instead installs the
 * recorded package versions and reopens that preserved installation, and never
 * initializes. The local writes are the host-key pin, retained before
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
      const incusRecord = await incusEvidence(root, record)
      requireNotStuck(await lineage.evidence(root, record), record.id)
      requireIncusNotStuck(incusRecord, record.id)
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
        reporter.space()
        reportRun(reporter)
        const zfsPreparer = await ZfsPreparer.open({
          root,
          deployment: record,
          target,
          recorded,
          remote,
          hooks: {
            show: (observation, plan) => reportZfsPlan(reporter, { observation, plan, target }),
            approve: async plan => {
              if (plan.kind === 'prerequisites' && plan.install.length > 0 && opened(await incusEvidence(root, record))) {
                throw new InstallerError({
                  code: 'ZFS_PLAN_REFUSED',
                  facts: [
                    [
                      'Reason',
                      'Qiln already opened Incus on this deployment, and installing ZFS packages could disturb the running daemon through package scripts, so Qiln never installs them under it.',
                    ],
                  ],
                  retry,
                })
              }
              await prompts.approve(zfsApproval(plan))
            },
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
        reporter.section('1/5 Incus close and repository')
        const incusClose = await incusPreparer.prepareSoftware(
          { account: username, retained: preserved },
          signal,
          'repository',
        )
        reporter.section('2/5 ZFS prerequisites')
        const zfsPrerequisites = await zfsPreparer.run(signal, 'software')
        reporter.section('3/5 Incus packages')
        const incusPackages = await incusPreparer.prepareSoftware(
          { account: username, retained: preserved },
          signal,
          'packages',
        )
        reporter.section('4/5 ZFS storage')
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
        reporter.section('5/5 Incus activation')
        const incusActivation = await incusPreparer.activate(
          { pool: pool.name, guid: pool.guid, datasets: pool.datasets, account: username, retained: preserved },
          signal,
        )
        const applied = incusClose + zfsPrerequisites + incusPackages + zfsStorage + incusActivation
        const changed =
          applied === 0
            ? 'Nothing was changed.'
            : `${applied} approved ${applied === 1 ? 'step was' : 'steps were'} applied and verified by fresh inspection.`
        const reopened = preserved !== null && preserved.origin !== record.id
        const daemon = reopened
          ? 'the preserved Incus installation was reopened without initialization and its instances remain stopped'
          : 'Incus was opened with local Unix-socket access'
        const next = reopened
          ? ' Use qiln installation reassign to move the existing installation to this deployment.'
          : ''
        return `Incus baseline prepared: ${daemon}. ${changed} The pool is a single disk with no redundancy or backup, group membership applies to new SSH connections only, and workload correctness and runtime readiness are not established.${next}`
      })
    })
  })
  reporter.summary(message)
}
