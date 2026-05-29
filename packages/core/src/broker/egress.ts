import type { ZodType } from 'zod'
import { UniversalSubjectBuilder } from '../subjects'
import type { NatsConnectionProvider } from './connection'

/**
 * Handles all outbound NATS publishing.
 */
export class BaseEgressManager<TPayload extends { type: string }> {
  constructor(
    private readonly connection: NatsConnectionProvider,
    private readonly schema: ZodType<TPayload>,
    private readonly subjectPrefix: string,
    private readonly loggerPrefix: string,
  ) {}

  /**
   * Publishes a strictly validated payload to the messaging bus.
   */
  async publish(target: string, payload: TPayload): Promise<void> {
    if (!this.connection.nc) {
      throw new Error(`${this.loggerPrefix} NATS Broker is not connected.`)
    }
    const parsed = this.schema.safeParse(payload)
    if (!parsed.success) {
      throw new Error(`${this.loggerPrefix} Invalid payload: ${parsed.error.message}`)
    }
    const [domain, ...actionParts] = payload.type.split('.')
    const action = actionParts.join('.')
    const subject = UniversalSubjectBuilder.build(this.subjectPrefix, target, domain, action)
    try {
      this.connection.nc.publish(subject, JSON.stringify(parsed.data))
    } catch (error) {
      console.error(`${this.loggerPrefix} Failed to publish to subject '${subject}':`, error)
      throw error
    }
  }
}
