import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { deploymentName } from '../../../aws/deployment/alias'
import { expectation, matches } from '../../../aws/deployment/expect'
import { cleanup, deploymentFacts, removable } from '../../../aws/deployment/facts'
import { removalPlan, retained, sshReady, unreleased } from '../../../aws/deployment/topology'
import { poolState, requirePoolReleased, requirePoolSettled } from '../../../aws/deployment/zfs/facts'
import { Preparer } from '../../../aws/deployment/zfs/prepare'
import { targetOf } from '../../../aws/deployment/zfs/target'
import { requireAwsHost } from '../../../aws/host'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { withConfirmedOperation } from '../shared'
import { openAccess, withRemote } from './access'
import { requireBaseline } from './baseline'
import { approvalLabel, reportPlan } from './prepare/preview'
import { progressSink } from './progress'
import { lifecycleOf, observationSummary, reportDeployment } from './report'
import { authenticateDeployer, openTarget, type Target } from './shared'
import * as lineage from '../../../aws/deployment/zfs/lineage'
import type { DeploymentSelector } from '../../../aws/deployment/alias'
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
    ...[...unreleased(record), ...kept].map((resource): DiagnosticFact => [resource.kind, `${resource.id} · ${lifecycleOf(resource)}`]),
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
 * Freshly checks the recorded pool over the pinned SSH connection, so a
 * successor host can import it without force. A pool still imported is exported
 * under its own default-no approval, and one observed absent only corroborates
 * the retained export evidence. Declining leaves the host untouched, and an
 * unreachable host refuses removal. Opening access may retain a host-key pin
 * through its own deployer, so the target is read again afterwards and the
 * caller never holds a stale record.
 */
async function checkPool(
  root: Dir,
  store: Dir,
  selector: DeploymentSelector,
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
  const access = await openAccess(root, target, retry, reporter, signal)
  const recorded = await lineage.pool(root, record)
  const { host, port, username, fingerprint } = access.options
  reporter.section('ZFS host check')
  reporter.row('working', 'Connecting', `${username}@${host}:${port} · pinned host key SHA256:${fingerprint}`)
  await withRemote(root, access, signal, async remote => {
    await requireBaseline(reporter, remote, username, record.id, [
      'Removal',
      'no ZFS check or export was completed and no AWS resource was changed',
    ])
    const preparer = await Preparer.open({
      root,
      deployment: record,
      target: zfsTarget,
      recorded,
      remote,
      hooks: {
        show: (observation, plan) => reportPlan(reporter, { observation, plan, target: zfsTarget }),
        approve: plan => prompts.approve(approvalLabel(plan)),
        progress: progressSink(reporter),
      },
    })
    await preparer.release(signal)
  })
  return await openTarget(root, store, selector)
}

export async function remove(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const { selector } = options
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment remove --${selector.kind} ${selector.value}`, reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      let target = await openTarget(root, store, selector)
      requirePoolSettled(await lineage.evidence(root, target.record), target.record.id)
      if (!removable(target.record)) {
        if (cleanup(target.record).status === 'not-needed' && retained(target.record).length > 0) {
          reportDeployment(reporter, target.record)
          return 'No removable resource remains. Retained resources are not removed by Qiln and keep incurring charges until they are deleted outside Qiln.'
        }
        throw refusal(target.record)
      }
      const poolOnRecord = poolState(await lineage.evidence(root, target.record))
      if ((poolOnRecord === 'imported' || poolOnRecord === 'exported') && sshReady(target.record)) {
        target = await checkPool(root, store, selector, target, prompts, reporter, signal)
      }
      requirePoolReleased(await lineage.evidence(root, target.record), target.record.id)
      const deployer = await authenticateDeployer(root, target, signal, progressSink(reporter))
      const observation = await deployer.observe(signal)
      const record = deployer.record
      if (unreleased(record).length === 0) {
        reportDeployment(reporter, record)
        return retained(record).length === 0
          ? 'All recorded resources were observed absent; no deletion call was made.'
          : 'All removable resources were observed absent; no deletion call was made. Retained resources remain; see the recorded resources.'
      }
      if (!matches(expectation(record), observation)) {
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
