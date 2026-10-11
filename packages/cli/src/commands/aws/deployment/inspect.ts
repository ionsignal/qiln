import type { Observation } from '../../../aws/deployment/types'
import { requireAwsHost } from '../../../aws/host'
import { withAwsOperation } from '../../../aws/root'
import type { AwsDeploymentOptions } from '../../../input'
import { withCancellation } from '../../../terminal/prompts'
import type { Reporter } from '../../../terminal/reporter'
import { authenticateDeployer, observationSummary, openTarget, reportDeployment } from './shared'

function reportCandidates(reporter: Reporter, candidates: readonly Observation[]): void {
  reporter.section('Tagged candidate VPCs')
  if (candidates.length === 0) {
    reporter.info('No tagged VPC was listed. An empty result does not prove that none exists.')
  }
  for (const candidate of candidates) {
    reporter.row('working', 'Candidate', `${candidate.vpcId} · ${observationSummary(candidate)}`)
  }
  reporter.notice('Candidates are displayed only. Qiln never adopts or deletes them, or treats an empty result as proof.')
}

export async function inspect(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const message = await withCancellation(async signal => {
    return await withAwsOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, options.id)
      const creation = target.record.creation
      if (creation === null) {
        reportDeployment(reporter, target.record)
        return 'Nothing to observe: creation was approved but never attempted.'
      }
      const deployer = await authenticateDeployer(root, target, signal)
      if (creation.returned !== null) {
        await deployer.observe(signal)
        reportDeployment(reporter, deployer.record)
        return 'Fresh observation retained. It does not establish launch readiness.'
      }
      const candidates = await deployer.candidates(signal)
      reportDeployment(reporter, deployer.record)
      reportCandidates(reporter, candidates)
      return 'No VPC identity was retained; candidates were displayed only.'
    })
  })
  reporter.summary(message)
}
