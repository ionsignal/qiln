import {
  defineGlobalRpc,
  UniversalSubjectBuilder,
  GlobalSubjectPrefix,
  SystemPingRequestSchema,
  SystemPingResponseSchema,
} from '@qiln/core/server'
import type { QilnEngineController } from '../../controller'

/**
 * Registers System RPC endpoints.
 * Handles basic connectivity and health checks over NATS.
 */
export function registerSystemRouter(host: QilnEngineController) {
  host.broker.serve(
    UniversalSubjectBuilder.build(GlobalSubjectPrefix.REQUEST, '*', 'host', 'ping'),
    defineGlobalRpc(
      SystemPingRequestSchema, // request schema
      SystemPingResponseSchema, // response schema
      async (input, target, domain, action) => {
        return {
          target,
          domain,
          action,
          receivedTimestamp: input.timestamp,
          serverTimestamp: Date.now(),
        }
      },
    ),
  )
}
