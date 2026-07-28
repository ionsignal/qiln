import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface WorkerNatsConfig {
  servers: string | string[]
  token?: string
}

export interface WorkerDatabaseConfig {
  url: string
}

export interface WorkerDefinitionsConfig {
  path: string
}

export interface WorkerIncusConfig {
  endpoint?: string
  cert?: string
  key?: string
  basicAuth?: string
  rejectUnauthorized?: boolean
  project?: string
}

export interface WorkerCaddyConfig {
  endpoint: string
  server: string
  fallbackId: string
  timeoutMs?: number
}

export interface WorkerRoutingConfig {
  baseDomain: string
}

export interface WorkerFeatureConfig {
  experimentalSnapshots?: boolean
}

export interface WorkerRuntimeConfig {
  database?: WorkerDatabaseConfig
  nats?: WorkerNatsConfig
  definitions?: WorkerDefinitionsConfig
  incus?: WorkerIncusConfig
  caddy?: WorkerCaddyConfig
  routing?: WorkerRoutingConfig
  features?: WorkerFeatureConfig
}

export interface WorkerRuntimeOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  config?: WorkerRuntimeConfig
}
