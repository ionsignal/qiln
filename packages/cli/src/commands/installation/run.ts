import { localTarget } from '../../installation/target/local'
import { withAwsTarget } from '../../installation/target/aws'
import { installationRetry } from '../../installation/retry'
import { withCancellation } from '../../terminal/prompts'
import { inspect as inspectTarget } from './inspect'
import { configure as configureTarget, type ConfigureOptions } from './configure'
import { reassign as reassignTarget } from './reassign'
import type { Reporter } from '../../terminal/reporter'
import type { DeploymentSelector } from '../../aws/deployment/alias'
import type { InstallationSelector, InstallationTarget } from '../../installation/target/types'

/**
 * The one cancellation scope of an installation invocation. Its signal is
 * handed to the target, which owns every request that can be cancelled. A local
 * target is built with the retry commands of the selected workflow. An AWS
 * target is resolved under the AWS lock, so it exists only while `use` runs.
 */
async function withTarget<T>(
  selector: InstallationSelector,
  use: (target: InstallationTarget) => Promise<T>,
): Promise<T> {
  return await withCancellation(signal =>
    selector.kind === 'local'
      ? use(localTarget(installationRetry(selector), signal))
      : withAwsTarget(selector, signal, use),
  )
}

export async function inspect(selector: InstallationSelector, reporter: Reporter): Promise<void> {
  await withTarget(selector, target => inspectTarget(target, reporter))
}

export async function configure(
  selector: InstallationSelector,
  options: ConfigureOptions,
  reporter: Reporter,
): Promise<void> {
  await withTarget(selector, target => configureTarget(target, options, reporter))
}

/**
 * Only an AWS deployment can be reassigned, so a local selector is not accepted.
 */
export async function reassign(selector: DeploymentSelector, reporter: Reporter): Promise<void> {
  await withCancellation(signal =>
    withAwsTarget(selector, signal, (target, aws) => reassignTarget(target, aws, reporter)),
  )
}
