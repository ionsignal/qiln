import type { QilnPersistence, QilnTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

export interface WorkerNatsConfig {
  servers: string | string[]
  token?: string
}

export interface WorkerDatabaseConfig {
  url: string
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
  experimentalCapture?: boolean
}

export interface WorkerRuntimeConfig {
  database?: WorkerDatabaseConfig
  nats?: WorkerNatsConfig
  definitions?: {
    path: string
  }
  incus?: WorkerIncusConfig
  features?: WorkerFeatureConfig
}

export interface WorkerRuntimeOptions<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends QilnTables = QilnTables,
> {
  persistence: QilnPersistence<TDatabase, TTables>
  config?: WorkerRuntimeConfig
}
