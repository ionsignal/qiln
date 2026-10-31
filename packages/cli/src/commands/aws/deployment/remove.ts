import { resolveAccess, withRemote } from './access'
import { requireBaseline } from './baseline'
import { progressSink } from './progress'
import { lifecycleOf, observationSummary, reportDeployment } from './report'
import { authenticateDeployer, openTarget, type Target } from './shared'
import { withConfirmedOperation } from '../../../aws/operation'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { deploymentName } from '../../../aws/deployment/volume/alias'
import { expectation, matches } from '../../../aws/deployment/observe/expect'
import { canSettle, cleanup, deploymentFacts, removable } from '../../../aws/deployment/observe/facts'
import { removalPlan, retained, sshReady, unreleased } from '../../../aws/deployment/topology'
import { evidence as incusEvidence } from '../../../aws/deployment/incus/evidence'
import { IncusPreparer } from '../../../aws/deployment/incus/prepare'
import {
  poolReturned,
  poolState,
  requireNotStuck as requireZfsNotStuck,
  requirePoolNotStuck,
  requirePoolReleased,
} from '../../../aws/deployment/zfs/facts'
import { ZfsPreparer } from '../../../aws/deployment/zfs/prepare'
import { targetOf } from '../../../aws/deployment/zfs/target'
import { requireAwsHost } from '../../../aws/host'
import { awsInstallationName } from '../../../installation/target/aws/host'
import { unsettled as installationUnsettled } from '../../../installation/journal/facts'
import { listInstallations } from '../../../installation/state'
import { stateOf } from '../../../journal/step'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { approvalLabel as incusApproval, reportPlan as reportIncusPlan } from './prepare/incus'
import { approvalLabel as zfsApproval, reportPlan as reportZfsPlan } from './prepare/zfs'
import {
  requireNotStuck as requireIncusNotStuck,
  requireStorageNotStuck,
  requireStorageReleased,
  storageTouched,
} from '../../../aws/deployment/incus/facts'
import * as configureJournal from '../../../installation/journal/records'
import * as lineage from '../../../aws/deployment/lineage/zfs'
import type { Action } from '../../../aws/deployment/graph'
import type { Dir } from '../../../state/files'
import type { Reporter } from '../../../terminal/reporter'
import type { Deployment, Observation } from '../../../aws/deployment/types'
import type { AwsDeploymentOptions } from '../../../input'

const EFFECTS: Partial<Record<Action, string>> = {
  'disassociate-address': 'Disassociate the Elastic IP from the primary network interface.',
  'release-address': 'Release the Elastic IP allocation.',
  'terminate-instance': 'Terminate the instance. AWS deletes its root volume and primary interface with it.',
  'delete-key-pair':
    'Delete the AWS key pair. This is not guest SSH revocation: guest authorized keys are unaffected, and Qiln neither reads nor deletes the local administrative key files.',
  'delete-group': 'Delete the security group.',
  'disassociate-subnet': 'Disassociate the route table from each subnet.',
  'delete-subnet': 'Delete each subnet.',
  'delete-route-table': 'Delete the route table.',
  'detach-gateway': 'Detach the internet gateway from the VPC.',
  'delete-gateway': 'Delete the internet gateway.',
  'delete-vpc': 'Delete the VPC.',
}

/**
 * What the host may still need before AWS removal: a pool step that returned
 * but was never verified, Incus initialized by Qiln, which is inspected freshly
 * even when an earlier release is retained because it may have been restarted
 * since, and a ZFS pool recorded as imported or exported.
 */
interface Holds {
  returned: boolean
  incus: boolean
  pool: boolean
}

/**
 * Read from the retained evidence on every call, because settling a returned
 * step can change the recorded pool state.
 */
async function holdsOf(root: Dir, record: Deployment): Promise<Holds> {
  const zfs = await lineage.evidence(root, record)
  const pool = poolState(zfs)
  return {
    returned: poolReturned(zfs).length > 0,
    incus: storageTouched(await incusEvidence(root, record)),
    pool: pool === 'imported' || pool === 'exported',
  }
}

/**
 * Stopping the workloads of an installation that is still being configured
 * could interleave with its Incus changes, so an unsettled configuration step
 * refuses the release. The journal is read without a lock, like status does.
 */
async function requireInstallationSettled(record: Deployment): Promise<void> {
  const retry = `qiln installation status --id ${record.id}`
  const name = await awsInstallationName({ kind: 'id', value: record.id })
  const entry = (await listInstallations(retry)).find(item => item.name === name)
  if (entry === undefined) {
    return
  }
  const open = installationUnsettled(await configureJournal.read(entry.directory, entry.record, retry))
  if (open.length > 0) {
    throw new InstallerError({
      code: 'INSTALLATION_UNRESOLVED',
      facts: [
        ['Installation', name],
        ['Unresolved steps', open.map(step => `${step.action} (${stateOf(step)})`).join(', ')],
      ],
      retry,
    })
  }
}

/**
 * Releasing the host writes to the ZFS journal, and to the Incus journal once
 * Incus was initialized. Neither journal accepts new work after an unresolved
 * step, whatever its action, so such a step refuses removal here, before any
 * connection or AWS call, instead of after the host was reached. The same holds
 * for an unsettled installation configuration, which the release must not
 * interleave with.
 */
async function requireReleaseJournals(root: Dir, record: Deployment, holds: Holds): Promise<void> {
  requireZfsNotStuck(await lineage.evidence(root, record), record.id)
  if (holds.incus) {
    requireIncusNotStuck(await incusEvidence(root, record), record.id)
    await requireInstallationSettled(record)
  }
}

function refusal(record: Deployment, observation?: Observation): InstallerError {
  const facts: DiagnosticFact[] = [...deploymentFacts(record)]
  if (observation) {
    facts.push(['Observed resources', observationSummary(observation)])
  }
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_REMOVAL_REFUSED',
    facts,
    retry: `qiln aws deployment inspect --id ${record.id}`,
  })
}

function reportTarget(reporter: Reporter, record: Deployment, observation: Observation): void {
  const kept = retained(record)
  const effects = [...new Set(removalPlan(record).map(({ action }) => EFFECTS[action] ?? action))]
  reporter.section('Deployment removal')
  reporter.facts([
    ['Deployment', record.id],
    ['Name', deploymentName(record.alias)],
    ['Account', record.binding.accountId],
    ['Deployment region', record.binding.region],
    ['CIDR', record.approval.cidr],
    ...[...unreleased(record), ...kept].map((resource): DiagnosticFact => [
      resource.kind,
      `${resource.id} · ${lifecycleOf(resource)}`,
    ]),
    ...record.approval.tags.map((tag): DiagnosticFact => ['Tag', `${tag.Key}=${tag.Value}`]),
  ])
  reporter.row('verified', 'Fresh observation', observationSummary(observation))
  reporter.section('Planned effects')
  for (const effect of effects) {
    reporter.line(`- ${effect}`)
  }
  reporter.space()
  reporter.info(
    `Removal runs ${removalPlan(record).length} provider calls in dependency order, each followed by an observation. It stops at the first refused or uncertain call; completed deletions are preserved and another invocation needs a fresh observation and approval.`,
  )
  reporter.info(
    'AWS refuses a deletion while dependent resources remain; Qiln never removes dependents and does not inventory them.',
  )
  reporter.info(
    "On success AWS also removes the VPC's default security group, network ACL, and main route table; flow logs are removed eventually.",
  )
  reporter.space()
  if (kept.length > 0) {
    reporter.notice(
      'Retained by design: the listed retained resources are not removed. Qiln has no DeleteVolume or DetachVolume authority, so a retained data volume remains and keeps incurring charges until it is deleted outside Qiln.',
    )
  }
  reporter.notice('Removal is not rolled back. Absence is observed afterwards and never proves who deleted a resource.')
}

/**
 * Releases the host over the pinned SSH connection, so a successor host can
 * import the recorded pool without force. A pool step that returned but was
 * never verified is settled first from a fresh inspection, which repeats
 * nothing and needs no approval. Then Incus is checked, under its own default-no
 * approval when it must be released, because a running daemon holds the pool;
 * Incus with a verified release already retained and every unit inactive is only
 * observed. Then a pool still imported is exported under its own approval, and
 * one observed absent only corroborates the retained export evidence. Declining
 * leaves the host untouched, and an unreachable host refuses removal. Resolving
 * access may retain a host-key pin, so the returned target carries the access
 * record, which includes it, and the caller never holds a stale record.
 */
async function releaseHost(
  root: Dir,
  target: Target,
  prompts: Prompts,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<Target> {
  const { record } = target
  const retry = `qiln aws deployment remove --id ${record.id}`
  const zfsTarget = targetOf(record)
  if (zfsTarget === null) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
      retry,
    })
  }
  const access = await resolveAccess(root, target, retry, reporter, signal)
  const { host, port, username, fingerprint } = access.options
  reporter.section('Host release check')
  reporter.row('working', 'Connecting', `${username}@${host}:${port} · pinned host key SHA256:${fingerprint}`)
  await withRemote(root, access, signal, async remote => {
    await requireBaseline(reporter, remote, username, record.id, [
      'Removal',
      'no Incus or ZFS settlement, release, check, or export was completed and no AWS resource was changed',
    ])
    const zfsPreparer = await ZfsPreparer.open({
      root,
      deployment: record,
      target: zfsTarget,
      recorded: await lineage.pool(root, record),
      remote,
      hooks: {
        show: (observation, plan) => reportZfsPlan(reporter, { observation, plan, target: zfsTarget }),
        approve: plan => prompts.approve(zfsApproval(plan)),
        progress: progressSink(reporter),
      },
    })
    if (await zfsPreparer.settle()) {
      reporter.row('verified', 'ZFS step', 'a returned step was verified by fresh inspection; nothing was rerun')
    }
    const holds = await holdsOf(root, record)
    if (holds.incus) {
      const recorded = await lineage.pool(root, record)
      if (recorded === null) {
        throw new InstallerError({
          code: 'INTERNAL_ERROR',
          retry,
        })
      }
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
      await incusPreparer.release({ pool: recorded.name, guid: recorded.guid, account: username }, signal)
    }
    if (holds.pool) {
      await zfsPreparer.release(signal)
    }
  })
  return { ...target, record: access.record }
}

export async function remove(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const { selector } = options
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment remove --${selector.kind} ${selector.value}`, reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      let target = await openTarget(root, store, selector)
      requirePoolNotStuck(await lineage.evidence(root, target.record), target.record.id)
      requireStorageNotStuck(await incusEvidence(root, target.record), target.record.id)
      if (!canSettle(target.record)) {
        throw refusal(target.record)
      }
      if (cleanup(target.record).status === 'not-needed') {
        if (retained(target.record).length === 0) {
          throw refusal(target.record)
        }
        reportDeployment(reporter, target.record)
        return 'No removable resource remains. Retained resources are not removed by Qiln and keep incurring charges until they are deleted outside Qiln.'
      }
      const holds = await holdsOf(root, target.record)
      if ((holds.returned || holds.incus || holds.pool) && sshReady(target.record)) {
        await requireReleaseJournals(root, target.record, holds)
        target = await releaseHost(root, target, prompts, reporter, signal)
      }
      requirePoolReleased(await lineage.evidence(root, target.record), target.record.id)
      requireStorageReleased(await incusEvidence(root, target.record), target.record.id)
      const deployer = await authenticateDeployer(root, target, signal, progressSink(reporter))
      const observation = await deployer.observe(signal)
      const record = deployer.record
      if (unreleased(record).length === 0) {
        reportDeployment(reporter, record)
        return retained(record).length === 0
          ? 'All recorded resources were observed absent; no deletion call was made.'
          : 'All removable resources were observed absent; no deletion call was made. Retained resources remain; see the recorded resources.'
      }
      if (!removable(record) || !matches(expectation(record), observation)) {
        throw refusal(record, observation)
      }
      reportTarget(reporter, record, observation)
      await prompts.approve('Remove the displayed deployment resources')
      reporter.space()
      await deployer.remove(observation, signal)
      reportDeployment(reporter, deployer.record)
      return retained(deployer.record).length === 0
        ? 'Recorded resources observed absent after approved removal; evidence retained.'
        : 'Removable resources observed absent after approved removal. Retained resources remain, are not removed by Qiln, and keep incurring charges until deleted outside Qiln; see the removal outcome.'
    })
  })
  reporter.summary(message)
}
