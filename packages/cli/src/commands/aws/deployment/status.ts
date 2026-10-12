import * as deployments from '../../../aws/deployment/records'
import { requireAwsHost } from '../../../aws/host'
import { openAwsRoot } from '../../../aws/root'
import type { AwsDeploymentOptions } from '../../../input'
import type { Reporter } from '../../../terminal/reporter'
import { notFound, reportDeployment } from './shared'

/** Lock-free and credential-free, so it works while another operation holds the lock. */
export async function status(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const root = await openAwsRoot()
  const record = root === null ? null : await deployments.read(root, options.id)
  if (!record) {
    throw notFound(options.id)
  }
  reportDeployment(reporter, record)
  reporter.info('This status read local evidence only. It did not authenticate, call AWS, or freshly observe the network.')
  if (record.steps.length > 0) {
    reporter.info(`Retain a fresh observation with: qiln aws deployment inspect --id ${record.id}`)
  }
  reporter.summary('Deployment evidence reported.')
}
