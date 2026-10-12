import * as deployments from '../../../aws/deployment/records'
import { requireAwsHost } from '../../../aws/host'
import { openAwsRoot } from '../../../aws/root'
import type { AwsDeploymentOptions } from '../../../input'
import type { Reporter } from '../../../terminal/reporter'
import { recordedState, reportDeployment } from './report'
import { notFound } from './shared'

export async function status(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const root = await openAwsRoot()
  const record = root === null ? null : await deployments.find(root, options.selector)
  if (!record) {
    throw notFound(options.selector)
  }
  reportDeployment(reporter, record)
  reporter.info('This status reads local evidence only. It did not authenticate, call AWS, or freshly observe the network.')
  if (record.steps.length > 0) {
    reporter.info(`To retain a fresh observation, run: qiln aws deployment inspect --id ${record.id}`)
  }
  reporter.summary(`Recorded state: ${recordedState(record).label}.`)
}
