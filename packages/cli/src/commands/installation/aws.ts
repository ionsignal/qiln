import { isAbsolute } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { requireTool } from '../../checks/host'
import { createIncusClient, readIncusServer, validateIncusServer } from '../../checks/incus'
import { validateIncusNetwork } from '../../checks/network'
import { validateIncusStorage } from '../../checks/storage'
import { architectureOf } from '../../install/architecture'
import { withAwsHost, type AwsHost } from '../../install/aws'
import { requireCapacity, requireCheckout, requireSupportedRelease } from '../../install/host'
import { inspectHost } from '../../remote/install/inspect'
import { installationRetry, type Retry } from '../../retry'
import type { DeploymentSelector } from '../../aws/deployment/alias'
import type { InstallationTarget } from './target'

const GIB = 1_073_741_824

/**
 * An AWS deployment as an installation target. Every observation travels over
 * the pinned SSH connection of the retained deployment: one session for each
 * host inspection and a new one for the Incus socket relay. Nothing is
 * observed about the operator's machine except `ssh-keygen`. The AWS lock held
 * by `withAwsHost` outlives the target, so it is only valid inside that scope.
 */
function awsTarget(aws: AwsHost, signal: AbortSignal, commands: Retry): InstallationTarget {
  const observe = (checkout: string | null) => aws.shell(signal, remote => inspectHost(remote, checkout))
  return {
    name: aws.name,
    retry: commands,
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
          aws.relay(signal, async connection => {
            const client = createIncusClient(connection)
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
 * resulting target to `run`. The signal bounds every SSH session of the target.
 */
export function withAwsTarget<T>(
  selector: DeploymentSelector,
  signal: AbortSignal,
  run: (target: InstallationTarget) => Promise<T>,
): Promise<T> {
  const commands = installationRetry(selector)
  return withAwsHost(selector, aws => run(awsTarget(aws, signal, commands)))
}
