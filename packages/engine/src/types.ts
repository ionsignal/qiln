import type { HostDbContract } from './db'
import type { inferRouterOutputs } from '@trpc/server'
import type { QilnEngineController } from './controller'
import type { HostRouter } from './trpc'

export interface HostNatsConfig {
  servers: string | string[]
  token?: string
}

export interface HostLibraryConfig {
  nats?: HostNatsConfig
  definitions?: {
    path: string
  }
}

export interface HostPluginOptions {
  db: HostDbContract
  config?: HostLibraryConfig
}

/**
 * The Context required by the QilnEngine tRPC router.
 */
export interface HostLibraryContext {
  user: {
    id: string
    username: string
  } | null
  host: QilnEngineController
}

type HostRouterOutputs = inferRouterOutputs<HostRouter>

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

export type CapsuleBranchItem = HostRouterOutputs['capsule']['list'][number]
