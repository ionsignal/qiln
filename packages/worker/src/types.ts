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
  socketPath?: string
  url?: string
  cert?: string
  key?: string
  authToken?: string
  rejectUnauthorized?: boolean
  project?: string
}

export interface WorkerFeatureConfig {
  experimentalSnapshots?: boolean
}

export interface WorkerRuntimeConfig {
  database?: WorkerDatabaseConfig
  nats?: WorkerNatsConfig
  definitions?: WorkerDefinitionsConfig
  incus?: WorkerIncusConfig
  features?: WorkerFeatureConfig
}

export interface WorkerRuntimeOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  persistence: CapsulePersistence<TDatabase, TTables>
  config?: WorkerRuntimeConfig
}
