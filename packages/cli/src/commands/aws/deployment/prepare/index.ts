import { RECIPE as INCUS_RECIPE } from '../../../../host/incus/recipe'
import { RECIPE as ZFS_RECIPE } from '../../../../host/zfs/recipe'
import { openTarget } from '../shared'
import { requireBaseline } from '../baseline'
import { resolveAccess, withRemote } from '../access'
import { progressSink } from '../progress'
import { InstallerError, type DiagnosticFact } from '../../../../diagnostic/error'
import { requireAwsHost } from '../../../../aws/host'
import { targetOf } from '../../../../aws/deployment/zfs/target'
import { requireNotStuck } from '../../../../aws/deployment/zfs/facts'
import { Prompts, withCancellation } from '../../../../terminal/prompts'
import { approve } from '../../../../terminal/approval'
import { IncusPreparer } from '../../../../aws/deployment/incus/prepare'
import { ZfsPreparer } from '../../../../aws/deployment/zfs/prepare'
import { withConfirmedOperation } from '../../../../aws/operation'
import { evidence as incusEvidence } from '../../../../aws/deployment/incus/evidence'
import { opened, requireNotStuck as requireIncusNotStuck } from '../../../../aws/deployment/incus/facts'
import { approvalLabel as incusApproval, reportPlan as reportIncusPlan } from './incus'
import { approvalLabel as zfsApproval, reportPlan as reportZfsPlan } from './zfs'
import * as incusLineage from '../../../../aws/deployment/lineage/incus'
import * as zfsLineage from '../../../../aws/deployment/lineage/zfs'
import type { AwsDeploymentOptions } from '../../../../input'
import type { Reporter } from '../../../../terminal/reporter'

const PHASE_COUNT = 5
const DIGEST_PREFIX_LENGTH = 12

function stepCount(count: number): string {
  return `${count} approved ${count === 1 ? 'step' : 'steps'}`
}

function recipeFact(): DiagnosticFact {
  return [
    'Recipes',
    `ZFS revision ${ZFS_RECIPE.revision} (${ZFS_RECIPE.digest.slice(0, DIGEST_PREFIX_LENGTH)}) · Incus revision ${INCUS_RECIPE.revision} (${INCUS_RECIPE.digest.slice(0, DIGEST_PREFIX_LENGTH)})`,
  ]
}

/**
 * Titles one phase and reports how many approved steps it applied. The count
 * comes from the preparer, so a phase that changed nothing says so.
 */
async function phase(reporter: Reporter, number: number, title: string, run: () => Promise<number>): Promise<number> {
  reporter.section(`Phase ${number}/${PHASE_COUNT} · ${title}`)
  const applied = await run()
  reporter.info(applied === 0 ? 'Nothing to change.' : `${stepCount(applied)} applied, each verified by fresh inspection.`)
  return applied
}

/**
 * Prepares the recorded data volume and the Incus installation on it, in five
 * phases. Each plans from a fresh inspection and is applied only after its own
 * default-no approval.
 * 1. Incus close and repository: persistent masks, then the Zabbly repository
 *    and a package-list refresh, before any package effect.
 * 2. ZFS prerequisites, refused once Qiln opened Incus, because a package
 *    script could disturb the running daemon.
 * 3. Incus packages: the exact pins, installed while the host is closed.
 * 4. ZFS storage: create the pool on a blank volume, or import it by its
 *    recorded GUID, then enable its scrub timer and mount its state dataset.
 * 5. Incus activation: the guard and open, then initialization of a fresh
 *    installation or the reopen of a preserved one, never initializing over
 *    retained state, then administrator socket access.
 * The local writes are the host-key pin, retained before connecting exactly as
 * for verify, and the retained ZFS and Incus preparation evidence.
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
      requireNotStuck(await zfsLineage.evidence(root, record), record.id)
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
      const recorded = await zfsLineage.pool(root, record)
      const { username } = access.options
      return await withRemote(root, access, signal, async remote => {
        await requireBaseline(reporter, remote, username, record.id, [
          'Preparation',
          'no ZFS or Incus inspection was performed',
        ])
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
              await approve(prompts, reporter, zfsApproval(plan))
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
            approve: plan => approve(prompts, reporter, incusApproval(plan)),
            progress: progressSink(reporter),
          },
        })
        let applied = 0
        applied += await phase(reporter, 1, 'Incus close and repository', () =>
          incusPreparer.prepareSoftware({ account: username, retained: preserved }, signal, 'repository'),
        )
        applied += await phase(reporter, 2, 'ZFS prerequisites', () => zfsPreparer.run(signal, 'software'))
        applied += await phase(reporter, 3, 'Incus packages', () =>
          incusPreparer.prepareSoftware({ account: username, retained: preserved }, signal, 'packages'),
        )
        applied += await phase(reporter, 4, 'ZFS storage', () => zfsPreparer.run(signal, 'storage'))
        const pool = await zfsLineage.pool(root, record)
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
        const datasets = pool.datasets
        applied += await phase(reporter, 5, 'Incus activation', () =>
          incusPreparer.activate(
            { pool: pool.name, guid: pool.guid, datasets, account: username, retained: preserved },
            signal,
          ),
        )
        const reopened = preserved !== null && preserved.origin !== record.id
        const facts: DiagnosticFact[] = [
          [
            'Incus',
            reopened
              ? 'The preserved installation was reopened without initialization, and its instances remain stopped.'
              : 'Incus was opened with local Unix-socket access.',
          ],
          ['Storage', 'The pool is a single disk with no redundancy or backup.'],
          ['Socket access', 'Group membership applies to new SSH connections only.'],
          ['Not established', 'Workload correctness and runtime readiness.'],
          recipeFact(),
        ]
        if (reopened) {
          facts.push(['Next', 'Use qiln installation reassign to move the existing installation to this deployment.'])
        }
        reporter.section('Result')
        reporter.facts(facts)
        return applied === 0
          ? 'Incus baseline prepared. Nothing was changed.'
          : `Incus baseline prepared. ${stepCount(applied)} applied and verified by fresh inspection.`
      })
    })
  })
  reporter.summary(message)
}
