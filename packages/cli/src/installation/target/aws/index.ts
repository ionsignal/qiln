import { PUBLISHED_PORTS, withAwsHost, type AwsHost } from './host'
import { managedCheckout } from './checkout'
import { inspectHost } from './inspect'
import { requireTool } from '../../preflight/host'
import { validateIncusNetwork } from '../../preflight/network'
import { validateIncusStorage } from '../../preflight/storage'
import { architectureOf } from '../../architecture'
import { installationRetry, type Retry } from '../../retry'
import { reportNetwork, reportStorage } from '../report'
import { createIncusClient, readIncusServer, validateIncusServer } from '../../preflight/incus'
import { requireCapacity, requireGit, requireSupportedRelease } from '../../host'
import type { DeploymentSelector } from '../../../aws/deployment/volume/alias'
import type { InstallationTarget } from '../types'

const GiB = 1_073_741_824

/**
 * An AWS deployment as an installation target. Every observation travels over
 * the pinned SSH connection of the retained deployment: one session for each
 * host inspection and checkout request, and a new one for the Incus socket
 * relay. Nothing about the operator's machine is observed except `ssh-keygen`.
 * The AWS lock held by `withAwsHost` outlives the target, so the target is only
 * valid inside that scope. The signal bounds the inspection sessions, while the
 * relay session ignores it and the Incus client observes it instead.
 */
function awsTarget(aws: AwsHost, signal: AbortSignal, commands: Retry): InstallationTarget {
  return {
    name: aws.name,
    retry: commands,
    signal,
    async withHost(reporter, retry, use) {
      const sshKeygen = await requireTool('ssh-keygen', retry)
      const observation = await aws.shell(signal, remote => inspectHost(remote, null))
      requireSupportedRelease(observation, retry)
      requireGit(observation.git, retry)
      const architecture = architectureOf(observation, retry)
      requireCapacity(aws.layout, observation.memoryBytes, retry)
      reporter.row(
        'verified',
        'Target',
        `Ubuntu ${observation.distributionVersion} · ${architecture.package} · kernel ${observation.kernelRelease} · ${(observation.memoryBytes / GiB).toFixed(1)} GiB memory`,
      )
      return await use({
        sshKeygen,
        architecture,
        binding: aws.host,
        layout: aws.layout,
        publish: { address: observation.address, ports: PUBLISHED_PORTS },
        checkout: managedCheckout(aws.record, retry, run => aws.shell(signal, run)),
        withIncus: useIncus =>
          aws.relay(async connection => {
            const client = createIncusClient(connection, signal)
            const server = await readIncusServer(client, connection.endpoint, retry)
            validateIncusServer(server, architecture, retry)
            reporter.row(
              'verified',
              'Incus',
              `${server.environment.serverVersion} through the pinned SSH Unix-socket relay · ${architecture.incus} supported`,
            )
            return await useIncus({
              client,
              extensions: server.apiExtensions,
              verifyLayout: async () => {
                const { layout } = aws
                reportStorage(reporter, layout, await validateIncusStorage(client, layout, retry))
                reportNetwork(reporter, layout, await validateIncusNetwork(client, layout, retry))
              },
            })
          }),
      })
    },
  }
}

/**
 * Resolves the selected deployment under the AWS-operation lock and hands the
 * resulting target, and the resolved host behind it, to `run`. The signal is
 * the cancellation of the invocation.
 */
export function withAwsTarget<T>(
  selector: DeploymentSelector,
  signal: AbortSignal,
  run: (target: InstallationTarget, aws: AwsHost) => Promise<T>,
): Promise<T> {
  const commands = installationRetry(selector)
  return withAwsHost(selector, aws => run(awsTarget(aws, signal, commands), aws))
}
