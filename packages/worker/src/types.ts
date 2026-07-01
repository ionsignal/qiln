import type { HostDbContract } from './db'

export interface WorkerNatsConfig {
  servers: string | string[]
  token?: string
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
  nats?: WorkerNatsConfig
  definitions?: {
    path: string
  }
  incus?: WorkerIncusConfig
}

export interface WorkerRuntimeOptions {
  db: HostDbContract
  config?: WorkerRuntimeConfig
  reconcileOnStart?: boolean
}
