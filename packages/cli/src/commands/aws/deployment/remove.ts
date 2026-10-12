import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { deploymentFacts, removable } from '../../../aws/deployment/facts'
import { expectation, matches, removalPlan, unreleased } from '../../../aws/deployment/topology'
import { requireAwsHost } from '../../../aws/host'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { withConfirmedOperation } from '../shared'
import { authenticateDeployer, observationSummary, openTarget, reportDeployment } from './shared'
import type { Deployment, Observation } from '../../../aws/deployment/types'
import type { AwsDeploymentOptions } from '../../../input'
import type { Reporter } from '../../../terminal/reporter'

function refusal(record: Deployment, observation?: Observation): InstallerError {
  const facts: DiagnosticFact[] = [...deploymentFacts(record)]
  if (observation) {
    facts.push(['Observed network', observationSummary(observation)])
  }
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_REMOVAL_REFUSED',
    facts,
    retry: `qiln aws deployment inspect --id ${record.id}`,
  })
}

function reportTarget(reporter: Reporter, record: Deployment, observation: Observation): void {
  reporter.section('Network removal')
  reporter.row('verified', 'Deployment', record.id)
  reporter.row('verified', 'Account', record.binding.accountId)
  reporter.row('verified', 'Region', record.binding.region)
  reporter.row('verified', 'CIDR', record.approval.cidr)
  reporter.row('verified', 'Observed', observationSummary(observation))
  for (const resource of unreleased(record)) {
    reporter.row('verified', resource.kind, resource.id)
  }
  for (const tag of record.approval.tags) {
    reporter.row('verified', 'Tag', `${tag.Key}=${tag.Value}`)
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
  reporter.notice('Removal is not rolled back. Absence is observed afterwards and never proves who deleted a resource.')
  reporter.space()
}

export async function remove(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment remove --id ${options.id}`, reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, options.id)
      if (!removable(target.record)) {
        throw refusal(target.record)
      }
      const deployer = await authenticateDeployer(root, target, signal)
      const observation = await deployer.observe(signal)
      const record = deployer.record
      if (observation.resources.every(resource => resource.state === 'absent') && unreleased(record).length === 0) {
        reportDeployment(reporter, record)
        return 'All recorded resources were observed absent; no deletion call was made.'
      }
      if (!matches(expectation(record), observation)) {
        throw refusal(record, observation)
      }
      reportTarget(reporter, record, observation)
      await prompts.approve('Remove the displayed network')
      await deployer.remove(observation, signal)
      reportDeployment(reporter, deployer.record)
      return 'Recorded resources observed absent after approved removal; evidence retained.'
    })
  })
  reporter.summary(message)
}
