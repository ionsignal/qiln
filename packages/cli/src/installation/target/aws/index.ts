import { isAbsolute } from 'node:path'
import { InstallerError } from '../../../diagnostic/error'
import { requireTool } from '../../preflight/host'
import { createIncusClient, readIncusServer, validateIncusServer } from '../../preflight/incus'
import { validateIncusNetwork } from '../../preflight/network'
import { validateIncusStorage } from '../../preflight/storage'
import { architectureOf } from '../../architecture'
import { withAwsHost, type AwsHost } from './host'
import { requireCapacity, requireCheckout, requireSupportedRelease } from '../../host'
import { inspectHost } from './inspect'
import { installationRetry, type Retry } from '../../retry'
import type { DeploymentSelector } from '../../../aws/deployment/alias'
import type { InstallationTarget } from '../types'

const GIB = 1_073_741_824

/**
 * An AWS deployment as an installation target. Every observation travels over
 * the pinned SSH connection of the retained deployment: one session for each
 * host inspection and a new one for the Incus socket relay. Nothing is
 * observed about the operator's machine except `ssh-keygen`. The AWS lock held
 * by `withAwsHost` outlives the target, so it is only valid inside that scope.
 * The signal bounds the inspection sessions, while the relay session ignores it
 * and the Incus client observes it instead.
 */
function awsTarget(aws: AwsHost, signal: AbortSignal, commands: Retry): InstallationTarget {
  const observe = (checkout: string | null) => aws.shell(signal, remote => inspectHost(remote, checkout))
  return {
    name: aws.name,
    retry: commands,
    signal,
    async withHost(reporter, retry, use) {
      const sshKeygen = await requireTool('ssh-keygen', retry)
      const observation = await observe(null)
      requireSupportedRelease(observation, retry)
      const architecture = architectureOf(observation, retry)
      requireCapacity(aws.layout, observation.memoryBytes, retry)
      reporter.row(
        'verified',
        'Target',
        `Ubuntu ${observation.distributionVersion} · ${architecture.package} · kernel ${observation.kernelRelease} · ${(observation.memoryBytes / GIB).toFixed(1)} GiB memory`,
      )
      return await use({
        binding: aws.host,
        architecture,
        layout: aws.layout,
        sshKeygen,
        checkout: async path => {
          if (!isAbsolute(path)) {
            throw new InstallerError({
              code: 'INVALID_SOURCE_ROOT',
              facts: [['Observed', 'The checkout path on an AWS target must be absolute.']],
              retry,
            })
          }
          return requireCheckout((await observe(path)).checkout, retry).path
        },
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
                const storage = await validateIncusStorage(client, layout, retry)
                reporter.row('verified', 'Storage pool', `${storage.incusPool.name} is compatible`)
                reporter.row(
                  'verified',
                  'PostgreSQL volume',
                  storage.existingPostgresVolume
                    ? `existing volume '${storage.existingPostgresVolume.name}' is compatible`
                    : `volume '${layout.postgres.volumeName}' is absent and was not created`,
                )
                const network = await validateIncusNetwork(client, layout, retry)
                reporter.row(
                  'verified',
                  'Network',
                  network.disposition === 'existing-compatible'
                    ? `existing managed network '${layout.network.name}' is compatible`
                    : `managed network '${layout.network.name}' is absent and ${layout.network.ipv4Subnet} is available`,
                )
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
