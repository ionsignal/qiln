import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { deploymentName } from '../../../aws/deployment/alias'
import { expectation, matches } from '../../../aws/deployment/expect'
import { cleanup, deploymentFacts, removable } from '../../../aws/deployment/facts'
import type { Action } from '../../../aws/deployment/graph'
import { removalPlan, retained, unreleased } from '../../../aws/deployment/topology'
import { requireAwsHost } from '../../../aws/host'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { withConfirmedOperation } from '../shared'
import { progressSink } from './progress'
import { lifecycleOf, observationSummary, reportDeployment } from './report'
import { authenticateDeployer, openTarget } from './shared'
import type { Deployment, Observation } from '../../../aws/deployment/types'
import type { AwsDeploymentOptions } from '../../../input'
import type { Reporter } from '../../../terminal/reporter'

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
    ['Region', record.binding.region],
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

export async function remove(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const { selector } = options
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment remove --${selector.kind} ${selector.value}`, reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, selector)
      if (!removable(target.record)) {
        if (cleanup(target.record).status === 'not-needed' && retained(target.record).length > 0) {
          reportDeployment(reporter, target.record)
          return 'No removable resource remains. Retained resources are not removed by Qiln and keep incurring charges until they are deleted outside Qiln.'
        }
        throw refusal(target.record)
      }
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
