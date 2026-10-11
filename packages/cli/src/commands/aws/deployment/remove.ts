import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { deploymentFacts, removable } from '../../../aws/deployment/facts'
import { verifies, type Deployment, type Observation } from '../../../aws/deployment/types'
import { requireAwsHost } from '../../../aws/host'
import { withAwsOperation } from '../../../aws/root'
import type { AwsDeploymentOptions } from '../../../input'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import type { Reporter } from '../../../terminal/reporter'
import { authenticateDeployer, observationSummary, openTarget, reportDeployment } from './shared'

function refusal(record: Deployment, observation?: Observation): InstallerError {
  const facts: DiagnosticFact[] = [...deploymentFacts(record)]
  if (observation) {
    facts.push(['Observed VPC', observationSummary(observation)])
  }
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_REMOVAL_REFUSED',
    facts,
    retry: `qiln aws deployment inspect --id ${record.id}`,
  })
}

function reportTarget(reporter: Reporter, record: Deployment, observation: Observation): void {
  reporter.section('VPC removal')
  reporter.row('verified', 'Deployment', record.id)
  reporter.row('verified', 'VPC', observation.vpcId)
  reporter.row('verified', 'Account', record.binding.accountId)
  reporter.row('verified', 'Region', record.binding.region)
  reporter.row('verified', 'CIDR', record.approval.cidr)
  reporter.row('verified', 'Observed', observationSummary(observation))
  for (const tag of record.approval.tags) {
    reporter.row('verified', 'Tag', `${tag.Key}=${tag.Value}`)
  }
  reporter.space()
  reporter.info(
    'DeleteVpc is called once. AWS refuses it while dependent resources remain; Qiln never removes dependents and does not inventory them.',
  )
  reporter.info(
    "On success AWS also removes the VPC's default security group, network ACL, and main route table; flow logs are removed eventually.",
  )
  reporter.notice('Removal is not rolled back. Absence is observed afterwards and never proves who deleted the VPC.')
  reporter.space()
}

export async function remove(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, `qiln aws deployment remove --id ${options.id}`, reporter)
    return await withAwsOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, options.id)
      if (!removable(target.record)) {
        throw refusal(target.record)
      }
      const deployer = await authenticateDeployer(root, target, signal)
      const observation = await deployer.observe(signal)
      const record = deployer.record
      if (observation.vpc === null) {
        reportDeployment(reporter, record)
        if (record.verified === null && record.removals.length === 0) {
          reporter.notice('Absence right after creation can be propagation delay; it does not clear unresolved creation.')
        }
        return 'The recorded VPC was observed absent; no DeleteVpc call was made.'
      }
      if (!verifies(observation, record)) {
        throw refusal(record, observation)
      }
      reportTarget(reporter, record, observation)
      await prompts.approve('Remove the displayed VPC')
      await deployer.remove(observation, signal)
      reportDeployment(reporter, deployer.record)
      return 'Recorded VPC observed absent after approved removal; evidence retained.'
    })
  })
  reporter.summary(message)
}
