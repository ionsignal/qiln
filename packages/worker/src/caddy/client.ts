import { z } from 'zod'
import { parseCaddyAdminEndpoint } from '../endpoint'
import { CaddyError, CaddyErrorCode, CaddyMutationOutcome } from './error'
import { CaddyRoutesClient } from './routes'
import { CaddyClientOptionsSchema } from './schema'
import { CaddyHttp } from './transport'
import type { CaddyClientOptions, ResolvedCaddyClientOptions } from './types'

/**
 * Worker-only capability for the strictly managed Caddy route array.
 *
 * Preview reconciliation and future route revisions own Caddy configuration
 * intent, verification, persistence, and cleanup policy outside this client.
 */
export class CaddyClient {
  public readonly routes: CaddyRoutesClient

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
    this.routes = new CaddyRoutesClient(this.transport, {
      server: this.options.server,
      fallbackId: this.options.fallbackId,
    })
  }

  /**
   * Startup validation is read-only so this client never adopts or repairs
   * infrastructure-owned Caddy configuration.
   */
  public async init(): Promise<void> {
    await this.routes.read()
  }

  public destroy(): void {
    this.transport.destroy()
  }
}
