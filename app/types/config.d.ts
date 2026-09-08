import type { FastifyInstance } from 'fastify'
import type { QilnEngineController } from '@qiln/engine/server'
import type { CapsuleNatsChannel } from '@qiln/core/server'
import type {
  QilnWorkerRuntime,
  WorkerRuntimeConfig,
  WorkerFeatureConfig,
  WorkerCaddyConfig,
  WorkerRoutingConfig,
} from '@qiln/worker/server'
import type { Session } from '@server/plugins/session'
import type { Database, Persistence } from '@server/db'
import type { SshControlClient } from '@server/ssh/client'
import type { UpgradeRouter } from '@server/websocket/router'

type MultipartConfig = {
  directory: string
  maxFieldSizeBytes: number
  maxFileSizeBytes: number
  maxFiles: number
  maxParts: number
  maxHeaderPairs: number
}

type LimitConfig = {
  global: boolean
  max: number
  timeWindow: number
}

type CookiesConfig = {
  name: string
  secret: string | undefined
  path: string
  domain: string | undefined
  sameSite: boolean | 'lax' | 'strict' | 'none'
  maxAge: number
}

type DevelopmentConfig = {
  publicOrigin: string
}

type MailgunConfig = {
  apiKey: string
  domain: string
  from: string
  mailingList: string
}

type WorkerConfig = {
  embedded: boolean
}

type DatabaseConfig = NonNullable<WorkerRuntimeConfig['database']>
type DefinitionConfig = NonNullable<WorkerRuntimeConfig['definitions']>
type IncusConfig = NonNullable<WorkerRuntimeConfig['incus']>
type NatsConfig = NonNullable<WorkerRuntimeConfig['nats']>
type CaddyConfig = WorkerCaddyConfig
type RoutingConfig = WorkerRoutingConfig
type FeatureConfig = Required<WorkerFeatureConfig>

type WorkerHostConfig = Omit<Required<WorkerRuntimeConfig>, 'features'> & {
  features: FeatureConfig
}

type Server = {
  server: FastifyInstance
  start: () => Promise<void>
  stop: () => Promise<void>
}

type Config = WorkerHostConfig & {
  dev: boolean
  listen: boolean
  host: string
  port: number
  path: string
  ssl: string
  development: DevelopmentConfig
  worker: WorkerConfig
  cookies: CookiesConfig
  multipart: MultipartConfig
  limit: LimitConfig
  mailgun: MailgunConfig
}

type EnvironmentConfig = Config

declare module 'http' {
  interface IncomingMessage {
    session?: Session | null
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session
  }

  interface FastifyInstance {
    db: Database
    persistence: Persistence
    engine: QilnEngineController
    worker: QilnWorkerRuntime | null
    channel: CapsuleNatsChannel
    ssh: SshControlClient
    upgrades: UpgradeRouter
    config: EnvironmentConfig
  }
}

export type {
  EnvironmentConfig,
  Config,
  Server,
  CookiesConfig,
  DevelopmentConfig,
  MultipartConfig,
  MailgunConfig,
  NatsConfig,
  DatabaseConfig,
  DefinitionConfig,
  IncusConfig,
  CaddyConfig,
  RoutingConfig,
  WorkerConfig,
  FeatureConfig,
}
