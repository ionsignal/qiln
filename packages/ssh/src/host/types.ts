/**
 * Host-authoritative SSH policy and advertised client connection settings.
 *
 * Listener configuration and persistent host-key loading remain
 * responsibilities of the application embedding the gateway.
 */
export interface SshPolicyConfig {
  enabled: boolean
  ticketTtlMs: number
  relayClosureTimeoutMs: number
  publicHost: string
  publicPort: number
  gatewayHostAlias: string
  branchHostAliasPrefix: string
  defaultIdentityFile: string
}

/**
 * Minimal logging dependency for detached authorized-key synchronization.
 *
 * A Host logger can satisfy this interface without introducing a Fastify
 * dependency into the SSH package.
 */
export interface SshSyncLogger {
  warn(fields: Record<string, unknown>, message: string): void
}
