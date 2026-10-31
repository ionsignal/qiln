import { reportDeployment } from './report'
import { authenticateDeployer, openTarget } from './shared'
import { expectation, matches } from '../../../aws/deployment/observe/expect'
import { healthDue, resources, unnamed } from '../../../aws/deployment/topology'
import { requireAwsHost } from '../../../aws/host'
import { withCancellation } from '../../../terminal/prompts'
import { withConfirmedOperation } from '../../../aws/operation'
import type { Reporter } from '../../../terminal/reporter'
import type { AwsDeploymentOptions } from '../../../input'
import type { Deployment, Observation } from '../../../aws/deployment/types'

function unrecorded(record: Deployment, candidates: readonly Observation[]): Observation[] {
  const known = resources(record)
  return candidates.filter(candidate =>
    candidate.resources.every(item => !known.some(resource => resource.kind === item.kind && resource.id === item.id)),
  )
}

function reportCandidates(reporter: Reporter, candidates: readonly Observation[]): void {
  reporter.section('Tagged candidate resources')
  if (candidates.length === 0) {
    reporter.info('No tagged resource was listed. An empty result does not prove that none exists.')
  }
  for (const candidate of candidates) {
    reporter.facts([
      ['Candidate', candidate.resources.map(resource => `${resource.kind} ${resource.id} · ${resource.state}`).join(', ')],
    ])
  }
  reporter.notice('Candidates are displayed only. Qiln never adopts or deletes them, or treats an empty result as proof.')
}

function healthNote(record: Deployment, read: boolean): string {
  if (record.health !== null) {
    return 'AWS health evidence is retained. '
  }
  return read ? 'AWS health did not pass on one read, so none was retained. ' : ''
}

export async function inspect(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const message = await withCancellation(async signal => {
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, options.selector)
      if (target.record.steps.length === 0) {
        reportDeployment(reporter, target.record)
        return 'Nothing to observe: creation was approved but no provider step was recorded.'
      }
      const recorded = resources(target.record).length > 0
      if (!recorded && unnamed(target.record).length === 0) {
        reportDeployment(reporter, target.record)
        return 'Nothing to observe: no resource identity was retained and no creation outcome is unresolved.'
      }
      const deployer = await authenticateDeployer(root, target, signal)
      const observation = recorded ? await deployer.observe(signal) : null
      const candidates = unnamed(deployer.record).length > 0 ? await deployer.candidates(signal) : null
      const agrees = observation !== null && matches(expectation(deployer.record), observation)
      const healthRead = agrees && healthDue(deployer.record)
      if (healthRead) {
        await deployer.health(signal)
      }
      const record = deployer.record
      reportDeployment(reporter, record)
      if (candidates !== null) {
        reportCandidates(reporter, unrecorded(record, candidates))
      }
      if (observation === null) {
        return 'No resource identity was retained; candidates were displayed only.'
      }
      return agrees
        ? `Fresh observation retained; it matches the record. ${healthNote(record, healthRead)}It does not establish SSH access, guest state, public reachability, or readiness.`
        : 'Fresh observation retained; it differs from the record. Nothing was changed.'
    })
  })
  reporter.summary(message)
}
