import { ACTION_LABELS, progressSink } from './progress'
import { resolveAccess, withRemote } from './access'
import { requireBaseline } from './baseline'
import { confirmCheckpoint, installationOf, planCheckpoint } from './checkpoint'
import { observationSummary, reportDeployment, reportResources } from './report'
import { authenticateDeployer, openTarget, type Target } from './shared'
import { withConfirmedOperation } from '../../../aws/operation'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { deploymentName } from '../../../aws/deployment/volume/alias'
import { expectation, matches } from '../../../aws/deployment/observe/expect'
import { canSettle, cleanup, deploymentFacts } from '../../../aws/deployment/observe/facts'
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
import { unsettled as installationUnsettled } from '../../../installation/journal/facts'
import { stateOf } from '../../../journal/step'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { approve, reportApproval, type ApprovalScreen, type ApprovalStep } from '../../../terminal/approval'
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
import type { Deployer } from '../../../aws/deployment/deployer'
import type { Dir } from '../../../state/files'
import type { Reporter } from '../../../terminal/reporter'
import type { Deployment, Observation } from '../../../aws/deployment/types'
import type { AwsDeploymentOptions } from '../../../input'

/**
 * Only the removals whose effect is easy to misread carry a caveat. The row
 * label already says what the other removals do.
 */
const CAVEATS: Partial<Record<Action, string>> = {
  'terminate-instance': 'AWS deletes the root volume and primary interface with it',
  'delete-key-pair': 'not guest SSH revocation; guest authorized keys and the local key files are unaffected',
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
  const entry = await installationOf(record)
  if (entry === null) {
    return
  }
  const open = installationUnsettled(await configureJournal.read(entry.directory, entry.record, retry))
  if (open.length > 0) {
    throw new InstallerError({
      code: 'INSTALLATION_UNRESOLVED',
      facts: [
        ['Installation', entry.name],
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

/**
 * The termination deletes the root volume, and the source checkout with it, so
 * once the instance is verified gone there is nothing left to protect.
 */
function terminationPending(record: Deployment): boolean {
  return removalPlan(record).some(({ action }) => action === 'terminate-instance')
}

function refusal(record: Deployment, reason: string, observation?: Observation): InstallerError {
  const facts: DiagnosticFact[] = [...deploymentFacts(record), ['Reason', reason]]
  if (observation) {
    facts.push(['Observed resources', observationSummary(observation)])
  }
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_REMOVAL_REFUSED',
    facts,
    retry: `qiln aws deployment inspect --id ${record.id}`,
  })
}

/**
 * One row per run of consecutive identical actions, so a deployment with three
 * subnets lists one subnet row. The calls themselves stay separate fenced steps.
 */
function removalSteps(record: Deployment): ApprovalStep[] {
  const groups: { action: Action; count: number }[] = []
  for (const { action } of removalPlan(record)) {
    const last = groups.at(-1)
    if (last?.action === action) {
      last.count += 1
    } else {
      groups.push({ action, count: 1 })
    }
  }
  return groups.map(({ action, count }) => ({
    label: count > 1 ? `${ACTION_LABELS[action]} x${count}` : ACTION_LABELS[action],
    detail: CAVEATS[action],
  }))
}

function removalScreen(record: Deployment): ApprovalScreen {
  const kept = retained(record).length > 0
  return {
    title: 'Proposed removal',
    steps: removalSteps(record),
    covers: `${removalPlan(record).length} provider calls in dependency order, each followed by an observation. Removal stops at the first refused or uncertain call.`,
    stays: kept
      ? 'Resources that Qiln did not record, which AWS refuses to delete under a recorded one, and the retained resources listed above. Qiln has no DeleteVolume or DetachVolume authority, so a retained data volume keeps incurring charges until it is deleted outside Qiln.'
      : 'Resources that Qiln did not record, which AWS refuses to delete under a recorded one.',
    lasting:
      "Completed deletions are not rolled back, and another invocation needs a fresh observation and approval. On success AWS also removes the VPC's default security group, network ACL, and main route table, and flow logs eventually.",
    notEstablished: 'Who deleted a resource: absence is observed afterwards and never proves it.',
  }
}

function reportTarget(reporter: Reporter, record: Deployment, observation: Observation): void {
  reporter.section('Deployment removal')
  reporter.facts([
    ['Deployment', record.id],
    ['Name', deploymentName(record.alias)],
    ['Account', record.binding.accountId],
    ['Deployment region', record.binding.region],
    ['CIDR', record.approval.cidr],
    ['Tags', record.approval.tags.map(tag => `${tag.Key}=${tag.Value}`).join(', ')],
  ])
  reportResources(reporter, record)
  reportApproval(reporter, removalScreen(record), {
    label: 'Fresh observation',
    detail: observationSummary(observation),
  })
}

/**
 * Releases the host over the pinned SSH connection, so a successor host can
 * import the recorded pool without force. A pool step that returned but was
 * never verified is settled first from a fresh inspection, which repeats
 * nothing and needs no approval. When an installation is assigned to this
 * deployment, the HEAD of its managed checkout is judged next, before any host
 * effect, and is recorded as the restore point only after the workloads stopped.
 * Then Incus is checked, under its own default-no approval when it must be
 * released, because a running daemon holds the pool; Incus with a verified
 * release already retained and every unit inactive is only observed. Then a pool
 * still imported is exported under its own approval, and one observed absent
 * only corroborates the retained export evidence. Declining leaves the host
 * untouched, and an unreachable host refuses removal. Resolving access may
 * retain a host-key pin, so the returned target carries the access record, which
 * includes it, and the caller never holds a stale record.
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
  const { username } = access.options
  await withRemote(root, access, signal, async remote => {
    await requireBaseline(reporter, remote, username, record.id, [
      'Removal',
      'no Incus or ZFS settlement, release, check, or export was completed and no AWS resource was changed',
    ])
    reporter.section('Host release')
    const zfsPreparer = await ZfsPreparer.open({
      root,
      deployment: record,
      target: zfsTarget,
      recorded: await lineage.pool(root, record),
      remote,
      hooks: {
        show: (observation, plan) => reportZfsPlan(reporter, { observation, plan, target: zfsTarget }),
        approve: plan => approve(prompts, reporter, zfsApproval(plan)),
        progress: progressSink(reporter),
      },
    })
    if (await zfsPreparer.settle()) {
      reporter.row('verified', 'ZFS step', 'a returned step was verified by fresh inspection; nothing was rerun')
    }
    const holds = await holdsOf(root, record)
    const checkpoint = holds.incus ? await planCheckpoint(record, remote, prompts, reporter, retry, true) : null
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
          approve: plan => approve(prompts, reporter, incusApproval(plan)),
          progress: progressSink(reporter),
        },
      })
      await incusPreparer.release({ pool: recorded.name, guid: recorded.guid, account: username }, signal)
    }
    await checkpoint?.pin()
    if (holds.pool) {
      await zfsPreparer.release(signal)
    }
  })
  return { ...target, record: access.record }
}

/**
 * Judges a fresh observation against the deployer's record, shows the removal,
 * and runs it only after a default-no approval. Returns false when the operator
 * declines, and then nothing was removed.
 */
export async function removeOnApproval(
  root: Dir,
  deployer: Deployer,
  observation: Observation,
  prompts: Prompts,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<boolean> {
  const record = deployer.record
  const plan = cleanup(record)
  if (plan.status !== 'eligible') {
    throw refusal(record, plan.detail, observation)
  }
  if (!matches(expectation(record), observation)) {
    throw refusal(record, 'The fresh observation does not agree with the record, so nothing was removed.', observation)
  }
  reportTarget(reporter, record, observation)
  if (!(await prompts.consent("Remove the deployment's AWS resources"))) {
    return false
  }
  if (terminationPending(record)) {
    await confirmCheckpoint(root, record, prompts, reporter, signal)
  }
  reporter.section('Removal')
  await deployer.remove(observation, signal)
  reportDeployment(reporter, deployer.record)
  return true
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
        throw refusal(target.record, cleanup(target.record).detail)
      }
      if (cleanup(target.record).status === 'not-needed') {
        reportDeployment(reporter, target.record)
        return retained(target.record).length === 0
          ? 'Nothing to remove: no recorded resource remains.'
          : 'No removable resource remains. Retained resources are not removed by Qiln and keep incurring charges until they are deleted outside Qiln.'
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
      if (unreleased(deployer.record).length === 0) {
        reportDeployment(reporter, deployer.record)
        return retained(deployer.record).length === 0
          ? 'All recorded resources were observed absent; no deletion call was made.'
          : 'All removable resources were observed absent; no deletion call was made. Retained resources remain; see the recorded resources.'
      }
      if (!(await removeOnApproval(root, deployer, observation, prompts, reporter, signal))) {
        throw new InstallerError({
          code: 'COMMAND_CANCELLED',
        })
      }
      return retained(deployer.record).length === 0
        ? 'Recorded resources observed absent after approved removal; evidence retained.'
        : 'Removable resources observed absent after approved removal. Retained resources remain, are not removed by Qiln, and keep incurring charges until deleted outside Qiln; see the removal outcome.'
    })
  })
  reporter.summary(message)
}
