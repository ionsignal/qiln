import type { CapsuleNatsChannelConfig } from '@qiln/core/server'
import type { SshPersistence } from '../db/persistence'
import type { SshGatewayConfig } from '../gateway/types'
import type { SshPolicyConfig, SshSyncLogger } from '../host/types'

export interface SshRuntimeLogger extends SshSyncLogger {
  info(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

/**
 * Application-supplied dependencies for one SSH authority.
 *
 * Persistence and the advisory-lock connection string must identify the same
 * PostgreSQL database. The application owns its persistence connection and
 * persistent host-key loading; the runtime owns its channel and lock session.
 */
export interface SshRuntimeOptions {
  persistence: SshPersistence
  connectionString: string
  nats: CapsuleNatsChannelConfig
  policy: SshPolicyConfig
  gateway?: SshGatewayConfig
  logger: SshRuntimeLogger
  shutdownTimeoutMs?: number

  /**
   * Must initiate process termination. Authority loss and incomplete shutdown
   * cannot be repaired by restarting this runtime inside the same process.
   */
  onFatal: (error: Error) => void
}
