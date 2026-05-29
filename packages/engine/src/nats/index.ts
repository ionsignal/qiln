import { registerSystemRouter } from './routers/system'
import type { QilnEngineController } from '../controller'

/**
 * Aggregates and registers all NATS RPC routers.
 * This decouples the transport layer registration from the core controller logic.
 *
 * @param host The main QilnEngineController instance
 */
export function registerNatsRouters(host: QilnEngineController) {
  registerSystemRouter(host)
}
