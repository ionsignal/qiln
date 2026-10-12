import { expectation, matches, resources } from '../../../aws/deployment/topology'
import type { Observation } from '../../../aws/deployment/types'
import { requireAwsHost } from '../../../aws/host'
import type { AwsDeploymentOptions } from '../../../input'
import { withCancellation } from '../../../terminal/prompts'
import type { Reporter } from '../../../terminal/reporter'
import { withConfirmedOperation } from '../shared'
import { reportDeployment } from './report'
import { authenticateDeployer, openTarget } from './shared'

function reportCandidates(reporter: Reporter, candidates: readonly Observation[]): void {
  reporter.section('Tagged candidate VPCs')
  if (candidates.length === 0) {
    reporter.info('No tagged VPC was listed. An empty result does not prove that none exists.')
  }
  for (const candidate of candidates) {
    reporter.facts([['Candidate', candidate.resources.map(resource => `${resource.id} · ${resource.state}`).join(', ')]])
  }
  reporter.notice('Candidates are displayed only. Qiln never adopts or deletes them, or treats an empty result as proof.')
}

export async function inspect(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const message = await withCancellation(async signal => {
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, options.selector)
      if (target.record.steps.length === 0) {
        reportDeployment(reporter, target.record)
        return 'Nothing to observe: creation was approved but never attempted.'
      }
      const deployer = await authenticateDeployer(root, target, signal)
      if (resources(target.record).length > 0) {
        const observation = await deployer.observe(signal)
        reportDeployment(reporter, deployer.record)
        return matches(expectation(deployer.record), observation)
          ? 'Fresh observation retained; it matches the record. It does not establish public reachability or launch readiness.'
          : 'Fresh observation retained; it differs from the record. Nothing was changed.'
      }
      const candidates = await deployer.candidates(signal)
      reportDeployment(reporter, deployer.record)
      reportCandidates(reporter, candidates)
      return 'No VPC identity was retained; candidates were displayed only.'
    })
  })
  reporter.summary(message)
}
