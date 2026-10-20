import { InstallerError } from '../../../diagnostic/error'
import { AWS_SPEC } from '../../../aws/spec'
import { deploymentFacts } from '../../../aws/deployment/facts'
import { sshReady } from '../../../aws/deployment/topology'
import { requireAwsHost } from '../../../aws/host'
import { readPrivateKey } from '../../../aws/ssh/private'
import { withSsh } from '../../../ssh/connections'
import { SshError } from '../../../ssh/failure'
import { withCancellation } from '../../../terminal/prompts'
import { withConfirmedOperation } from '../shared'
import { progressSink } from './progress'
import { authenticateDeployer, openTarget, type Target } from './shared'
import type { Dir } from '../../../state/files'
import type { HostKey } from '../../../aws/deployment/hostkey'
import type { Deployment } from '../../../aws/deployment/types'
import type { AwsDeploymentOptions } from '../../../input'
import type { SshOptions } from '../../../ssh/options'
import type { Reporter } from '../../../terminal/reporter'

const ACCOUNT_COMMAND = 'id -un'

/**
 * A retained pin is used as is, with no AWS call and no AWS credentials.
 * Otherwise the pin is resolved and retained before any connection is made.
 */
async function pinOf(root: Dir, target: Target, reporter: Reporter, signal: AbortSignal): Promise<HostKey> {
  if (target.record.hostKey !== null) {
    reporter.row('reused', 'SSH host key', 'retained pin used; no AWS call was made')
    return target.record.hostKey
  }
  const deployer = await authenticateDeployer(root, target, signal, progressSink(reporter))
  return await deployer.hostKey(signal)
}

async function verifyLogin(
  connection: SshOptions,
  privateKey: Buffer,
  signal: AbortSignal,
  record: Deployment,
): Promise<void> {
  try {
    await withSsh(connection, privateKey, signal, async remote => {
      const result = await remote.exec(ACCOUNT_COMMAND)
      if (result.exitCode !== 0 || result.stdout.trim() !== connection.username) {
        throw new SshError({
          kind: 'command',
          facts: [
            ['Command failure', 'unexpected result'],
            ['Exit code', String(result.exitCode)],
            ['Expected account', connection.username],
          ],
        })
      }
    })
  } catch (error: unknown) {
    if (error instanceof SshError && error.kind === 'connection') {
      throw new InstallerError({
        code: error.code,
        facts: [...error.facts, ['Administrator network', record.approval.ingress[0].cidr]],
        retry: `qiln aws deployment ssh --id ${record.id}`,
      })
    }
    throw error
  }
}

/**
 * Proves one pinned, key-authenticated login as the bootstrap account. Nothing
 * is installed or changed on the host, and the result is not retained.
 */
export async function ssh(options: AwsDeploymentOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const message = await withCancellation(async signal => {
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const target = await openTarget(root, store, options.selector)
      const { record } = target
      if (!sshReady(record)) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_ACCESS_REFUSED',
          facts: [
            ...deploymentFacts(record),
            ['Observed', 'Creation is not fully verified, removal has begun, or no administrative key is bound.'],
          ],
          retry: `qiln aws deployment status --id ${record.id}`,
        })
      }
      const privateKey = await readPrivateKey(root, record)
      try {
        const pin = await pinOf(root, target, reporter, signal)
        const { bootstrap } = record.approval.host.plan
        const connection: SshOptions = {
          host: pin.address,
          port: record.approval.ingress[0].port,
          username: bootstrap.user,
          fingerprint: pin.fingerprint,
          ...AWS_SPEC.deployment.ssh,
        }
        reporter.section('SSH login')
        reporter.row('working', 'Connecting', `${connection.username}@${connection.host}:${connection.port}`)
        await verifyLogin(connection, privateKey, signal, record)
        reporter.row(
          'verified',
          'SSH login',
          `pinned host key SHA256:${pin.fingerprint} matched · administrative key accepted · '${ACCOUNT_COMMAND}' returned ${connection.username}`,
        )
        reporter.space()
        reporter.info(
          'The host key is AWS-reported console evidence, not an AWS-signed certificate or guest attestation. No other authentication method was attempted.',
        )
        return 'SSH login verified. This is not host preparation, guest compatibility, effective sshd settings, or readiness.'
      } finally {
        privateKey.fill(0)
      }
    })
  })
  reporter.summary(message)
}
