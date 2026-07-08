import type { CapsuleHostDbContract } from '@qiln/core/server'
import type { inferRouterOutputs } from '@trpc/server'
import type { QilnEngineController } from './controller'
import type { EngineRouter } from './trpc'

export interface EngineNatsConfig {
  servers: string | string[]
  token?: string
}

export interface EngineConfig {
  nats?: EngineNatsConfig
  definitions?: {
    path: string
  }
}

export interface EnginePluginOptions {
  db: CapsuleHostDbContract
  config?: EngineConfig
}

/**
 * The Context required by the QilnEngine tRPC router.
 */
export interface EngineContext {
  user: {
    id: string
    username: string
  } | null
  engine: QilnEngineController
}

type EngineRouterOutputs = inferRouterOutputs<EngineRouter>

export type FileType = 'text' | 'image' | 'config' | 'archive' | 'binary' | 'unknown'

export type FileEntry =
  | { type: 'file'; path: string; name: string; size: number; modified: string; extension: string }
  | { type: 'directory'; path: string; name: string; modified: string; childCount: number }

export interface MockFsNode {
  type: 'file' | 'directory'
  name: string
  modified: string
  size?: number
  content?: string
  children?: Record<string, MockFsNode>
}

/**
 * Narrow retained type for the mock file browser surface.
 *
 * Extra metadata is intentionally modeled as unknown so the retained demo vault
 * fixtures can keep their old shape without reintroducing broad workspace/vault
 * product concepts into the capsule API boundary.
 */
export interface FileBrowserVault {
  id: string
  name: string
  root: MockFsNode
  [key: string]: unknown
}

export type FileSortKey = 'name' | 'size' | 'modified' | 'type'
export type FileSortOrder = 'ascend' | 'descend'
export type FileBrowserMode = 'browsing' | 'editing'

export interface EditorTab {
  id: string
  path: string
  name: string
  dirty: boolean
}

export type FileInspectorTarget =
  | { type: 'file'; path: string; name: string; size: number; modified: string; extension: string; content: string | null; fileType: FileType }
  | { type: 'directory'; path: string; name: string; modified: string; childCount: number }

export type CapsuleBranchItem = EngineRouterOutputs['capsules']['branch']['list'][number]
