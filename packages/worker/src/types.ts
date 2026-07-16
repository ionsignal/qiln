import type { CapsuleHostDbContract } from '@qiln/core/server'

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

export interface WorkerRuntimeConfig {
  database?: WorkerDatabaseConfig
  nats?: WorkerNatsConfig
  definitions?: {
    path: string
  }
  incus?: WorkerIncusConfig
}

export interface WorkerRuntimeOptions {
  db: CapsuleHostDbContract
  config?: WorkerRuntimeConfig
}
