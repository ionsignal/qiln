import fs from 'node:fs/promises'
import fp from 'fastify-plugin'
import { QilnSshGateway } from '@qiln/ssh/server'
import { registerSshAccessControlHandlers } from '@server/ssh/channel'
import { SshHostPolicy } from '@server/ssh/policy'
import { SshAuthorizedKeysSyncDispatcher } from '@server/ssh/sync'

async function readPersistentGatewayHostKey(path: string): Promise<Buffer> {
  if (path.trim() === '') {
    throw new Error('QILN_SSH_GATEWAY_HOST_KEY_PATH is required when the SSH gateway is enabled.')
  }
  const metadata = await fs.stat(path)
  if (!metadata.isFile()) {
    throw new Error('The configured SSH gateway host key path must identify a regular file.')
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('The SSH gateway host key must not be readable or writable by group or other users.')
  }
  const key = await fs.readFile(path)
  if (key.length === 0) {
    throw new Error('The configured SSH gateway host key is empty.')
  }
  return key
}

export default fp(
  async fastify => {
    const authorizedKeysSync = new SshAuthorizedKeysSyncDispatcher(fastify.db, fastify.channel, fastify.log)
    const policy = new SshHostPolicy(fastify.db, fastify.config.ssh, authorizedKeysSync)
    fastify.decorate('sshPolicy', policy)

    registerSshAccessControlHandlers(fastify.channel, policy)

    const gatewayConfig = fastify.config.ssh.gateway
    if (gatewayConfig.enabled && !fastify.config.ssh.enabled) {
      throw new Error('The SSH gateway cannot be enabled while Host SSH policy is disabled.')
    }
    if (!gatewayConfig.enabled) {
      fastify.log.info(
        {
          policyEnabled: fastify.config.ssh.enabled,
          gatewayEnabled: false,
        },
        '[SSH] Host SSH policy initialized without the public gateway listener',
      )
      return
    }
    if (fastify.config.ssh.ticketTtlMs <= gatewayConfig.channelOpenTimeoutMs) {
      throw new Error('SSH ticket TTL must be greater than the gateway channel-open timeout.')
    }
    const hostKey = await readPersistentGatewayHostKey(gatewayConfig.hostKeyPath)
    const gateway = new QilnSshGateway(
      {
        bindHost: gatewayConfig.bindHost,
        bindPort: gatewayConfig.bindPort,
        gatewayInstanceId: gatewayConfig.instanceId,
        hostKeys: [hostKey],
        maxConnections: gatewayConfig.maxConnections,
        maxRelays: gatewayConfig.maxRelays,
        authenticationTimeoutMs: gatewayConfig.authenticationTimeoutMs,
        channelOpenTimeoutMs: gatewayConfig.channelOpenTimeoutMs,
        branchDialTimeoutMs: gatewayConfig.branchDialTimeoutMs,
      },
      policy,
    )
    policy.setRelayCloser(gateway)
    try {
      const recoveredRelayCount = await policy.recoverGatewayRelays(gatewayConfig.instanceId)
      await gateway.start()
      fastify.log.info(
        {
          bindHost: gatewayConfig.bindHost,
          bindPort: gatewayConfig.bindPort,
          gatewayInstanceId: gatewayConfig.instanceId,
          recoveredRelayCount,
          maxConnections: gatewayConfig.maxConnections,
          maxRelays: gatewayConfig.maxRelays,
        },
        '[SSH] Qiln SSH gateway started',
      )
    } catch (error: unknown) {
      await gateway.stop().catch(() => undefined)
      throw error
    }
    fastify.addHook('onClose', async () => {
      fastify.log.info('[SSH] Stopping Qiln SSH gateway and closing local relays...')
      await gateway.stop()
    })
  },
  {
    name: 'ssh',
    dependencies: ['db', 'capsule-channel'],
  },
)
