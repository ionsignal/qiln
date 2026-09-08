import { SshGatewayDiagnosticSchema } from '@qiln/core/server'
import { SshRuntime } from '@qiln/ssh/server'
import { createDatabase } from './db'
import { readHostKey } from './key'
import type { Logger } from 'pino'
import type { SshConfig } from './config'

export interface SshService {
  stop(): Promise<void>
}

/**
 * The application owns configuration, persistence, and host-key loading.
 * SshRuntime owns singleton authority, policy, the gateway, and its channel.
 */
export async function startSsh(
  config: SshConfig,
  logger: Logger,
  onFatal: (error: Error) => void,
): Promise<SshService> {
  const gatewayConfig = config.gateway
  if (gatewayConfig.enabled && !config.policy.enabled) {
    throw new Error('The SSH gateway cannot be enabled while SSH policy is disabled.')
  }
  const hostKey = gatewayConfig.enabled ? await readHostKey(gatewayConfig.hostKeyPath) : null
  const database = createDatabase(config.database.url)
  try {
    const runtime = new SshRuntime({
      persistence: database.persistence,
      connectionString: config.database.url,
      nats: config.nats,
      policy: config.policy,
      logger,
      ...(hostKey === null
        ? {}
        : {
            gateway: {
              bindHost: gatewayConfig.bindHost,
              bindPort: gatewayConfig.bindPort,
              gatewayInstanceId: gatewayConfig.instanceId,
              hostKeys: [hostKey],
              maxConnections: gatewayConfig.maxConnections,
              maxRelays: gatewayConfig.maxRelays,
              authenticationTimeoutMs: gatewayConfig.authenticationTimeoutMs,
              channelOpenTimeoutMs: gatewayConfig.channelOpenTimeoutMs,
              branchDialTimeoutMs: gatewayConfig.branchDialTimeoutMs,
              onDiagnostic: event => {
                const parsed = SshGatewayDiagnosticSchema.safeParse(event)
                if (!parsed.success) {
                  logger.warn('[SSH] Gateway diagnostic failed validation.')
                  return
                }
                const diagnostic = parsed.data
                const fields = {
                  sshGateway: diagnostic,
                }
                if (diagnostic.outcome === 'failed') {
                  logger.error(fields, '[SSH] Gateway failure')
                  return
                }
                if (
                  diagnostic.outcome === 'timed_out' ||
                  (diagnostic.outcome === 'rejected' && diagnostic.stage !== 'request')
                ) {
                  logger.warn(fields, '[SSH] Gateway request did not proceed')
                  return
                }
                if (diagnostic.stage === 'gateway') {
                  logger.info(fields, '[SSH] Gateway lifecycle')
                  return
                }
                logger.debug(fields, '[SSH] Gateway progress')
              },
            },
          }),
      onFatal,
    })
    await runtime.start()
    let shutdown: Promise<void> | null = null
    return {
      stop(): Promise<void> {
        if (!shutdown) {
          shutdown = (async () => {
            // Persistence remains available until accepted policy calls and
            // gateway closures drain and singleton authority is released.
            await runtime.stop()
            await database.close()
          })()
        }
        return shutdown
      },
    }
  } catch (error: unknown) {
    await database.close()
    throw error
  }
}
