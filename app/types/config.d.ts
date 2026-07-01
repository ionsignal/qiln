import type { UserInputConfig } from 'c12'
import type { FastifyInstance } from 'fastify'
import type { QilnEngineController } from '@qiln/engine/server'
import type { QilnWorkerRuntime } from '@qiln/worker/server'
import type { Session } from '@server/plugins/session'
import type { Database } from '@server/db'

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
  path: string
  domain: string | undefined
  sameSite: boolean | 'lax' | 'strict' | 'none'
  maxAge: number
}

type MailgunConfig = {
  apiKey: string
  domain: string
  from: string
  mailingList: string
}

type DatabaseConfig = {
  url: string
}

type DefinitionConfig = {
  path: string
}

type WorkerConfig = {
  embedded: boolean
  reconcileOnStart: boolean
}

export interface IncusConfig {
  socketPath?: string
  url?: string
  cert?: string
  key?: string
  authToken?: string
  rejectUnauthorized?: boolean
}

type NatsConfig = {
  servers: string | string[]
  token?: string
}

type Server = {
  server: FastifyInstance
  start: () => Promise<void>
  stop: () => Promise<void>
}

type Config = {
  dev: boolean
  listen: boolean
  host: string
  port: number
  path: string
  ssl: string
  definitions: DefinitionConfig
  worker: WorkerConfig
  cookies: CookiesConfig
  multipart: MultipartConfig
  limit: LimitConfig
  mailgun: MailgunConfig
  database: DatabaseConfig
  nats: NatsConfig
  incus: IncusConfig
}

type EnvironmentConfig = UserInputConfig & Config

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
    host: QilnEngineController
    worker: QilnWorkerRuntime | null
    config: EnvironmentConfig
  }
}

export type { EnvironmentConfig, Config, Server, CookiesConfig, MultipartConfig, MailgunConfig, NatsConfig, DatabaseConfig, WorkerConfig }
