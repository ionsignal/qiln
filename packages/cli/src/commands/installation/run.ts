import { installationRetry } from '../../retry'
import { withCancellation } from '../../terminal/prompts'
import { withAwsTarget } from './aws'
import { configure as configureTarget, type ConfigureOptions } from './configure'
import { inspect as inspectTarget } from './inspect'
import { localTarget } from './local'
import type { Reporter } from '../../terminal/reporter'
import type { InstallationSelector, InstallationTarget } from './target'

/**
 * A local target only needs its retry commands renamed for the named workflow.
 * An AWS target is resolved under the AWS lock, so it exists only while `use`
 * runs.
 */
async function withTarget<T>(
  selector: InstallationSelector,
  use: (target: InstallationTarget) => Promise<T>,
): Promise<T> {
  if (selector.kind === 'local') {
    return await use({ ...localTarget, retry: installationRetry(selector) })
  }
  return await withCancellation(signal => withAwsTarget(selector, signal, use))
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
