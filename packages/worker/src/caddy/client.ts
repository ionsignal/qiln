import { z } from 'zod'
import { parseCaddyAdminEndpoint } from '../endpoint'
import { CaddyError, CaddyErrorCode, CaddyMutationOutcome } from './error'
import { CaddyAliasesClient } from './aliases'
import { CaddyClientOptionsSchema } from './schema'
import { CaddyHttp } from './transport'
import type { CaddyClientOptions, ResolvedCaddyClientOptions } from './types'

/**
 * Worker-only capability for the strictly managed Caddy alias route array.
 *
 * Promotion, rollback, provider intent, runtime materialization, verification,
 * persistence, and cleanup policy remain outside this client boundary.
 */
export class CaddyClient {
  public readonly aliases: CaddyAliasesClient

  private readonly transport: CaddyHttp
  private readonly options: ResolvedCaddyClientOptions

  constructor(options: CaddyClientOptions) {
    const parsedOptions = CaddyClientOptionsSchema.safeParse(options)

    if (!parsedOptions.success) {
      throw new CaddyError('Invalid Caddy client configuration.', {
        code: CaddyErrorCode.VALIDATION_ERROR,
        outcome: CaddyMutationOutcome.NOT_ATTEMPTED,
        details: {
          validation: z.treeifyError(parsedOptions.error),
        },
      })
    }

    this.options = parsedOptions.data
    this.transport = new CaddyHttp({
      endpoint: parseCaddyAdminEndpoint(this.options.endpoint),
      timeoutMs: this.options.timeoutMs,
    })
    this.aliases = new CaddyAliasesClient(this.transport, {
      server: this.options.server,
      fallbackId: this.options.fallbackId,
    })
  }

  /**
   * Startup validation is read-only so this client never adopts or repairs
   * infrastructure-owned Caddy configuration.
   */
  public async init(): Promise<void> {
    await this.aliases.read()
  }

  public destroy(): void {
    this.transport.destroy()
  }
}
