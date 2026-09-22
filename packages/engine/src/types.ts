import type { inferRouterOutputs } from '@trpc/server'
import type { QilnEngineController } from './controller'
import type { EnginePersistence } from './persistence'
import type { EngineRouter } from './trpc'

export interface EngineNatsConfig {
  servers: string | string[]
  token?: string
}

export interface EngineConfig {
  nats?: EngineNatsConfig
}

export interface EnginePluginOptions {
  persistence: EnginePersistence
  config?: EngineConfig
}

/**
 * Context required by the QilnEngine tRPC router.
 *
 * The Host owns authentication and derives administrator authorization from the
 * authenticated session. Engine receives only the minimal trusted identity and
 * authorization fields required by capsule mutation services.
 */
export interface EngineContext {
  user: {
    id: string
    username: string
    isAdmin: boolean
  } | null
  engine: QilnEngineController
}

type EngineRouterOutputs = inferRouterOutputs<EngineRouter>

export type CapsuleBranchSummary = EngineRouterOutputs['capsules']['branches']['list'][number]
export type CapsuleOperationSummary = EngineRouterOutputs['capsules']['operations']['get']

/**
 * Client-safe committed snapshot summary inferred from the Engine router.
 *
 * Create Snapshot retains restoration evidence, not diff review, golden-test
 * results, or promotion approval. Physical provider references, historical
 * Blueprint and rootfs image pins, and operation diagnostics remain
 * server-only.
 */
export type CapsuleSnapshotSummary = EngineRouterOutputs['capsules']['snapshots']['list'][number]
