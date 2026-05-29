import type { ComputedRef, Ref } from 'vue'
import type { HostDbContract } from './db'
import type { inferRouterOutputs } from '@trpc/server'
import type { ZodType, output } from 'zod'
import type { QilnEngineController } from './controller'
import type { HostRouter } from './trpc'
import type { HostEvent } from './schemas/events'

export interface HostNatsConfig {
  servers: string | string[]
  token?: string
}

export interface HostLibraryConfig {
  nats?: HostNatsConfig
  definitions?: {
    path: string
  }
  incus?: {
    socketPath?: string
    url?: string
    cert?: string
    key?: string
    authToken?: string
    rejectUnauthorized?: boolean
    project?: string
  }
}

export interface HostEventBroker {
  start(): Promise<void>
  shutdown(): Promise<void>
  publish(target: string, event: HostEvent): Promise<void>
  request<TOutput extends ZodType>(subject: string, payload: unknown, responseSchema: TOutput, timeoutMs?: number): Promise<output<TOutput>>
  serve(subject: string, handler: (subject: string, data: unknown) => Promise<unknown>, opts?: { queue?: string }): void
  subscribe(filter: (event: HostEvent) => boolean): AsyncIterable<HostEventEnvelope>
}

export interface HostEventEnvelope {
  target: string
  event: HostEvent
  routing: { type: 'broadcast' } | { type: 'unicast'; userId: string }
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

export type { HostEvent }

type HostRouterOutputs = inferRouterOutputs<HostRouter>
export type HostInstanceItem = HostRouterOutputs['instance']['list'][number]

/**
 * Stubbed Types
 * TODO: stubbed types must be finalized and integrated (eventually)
 */
export interface WorkspaceLease {
  id: string
  gpuType: string
  efficiency: number
  vramUsed: number
  vramTotal: number
  temp: number
  timeRemaining: string
}

export interface GpuLeaseInfo {
  gpuType: string
  count: number
  vramUsedGB: number
  vramTotalGB: number
  tempCelsius: number
  utilization: number
  leasedSince: string
}

export type GpuLeaseState =
  | { status: 'none' }
  | { status: 'requesting' }
  | { status: 'attached'; lease: GpuLeaseInfo }
  | { status: 'releasing' }
  | { status: 'ineligible' }

export interface GpuPoolAvailability {
  gpuType: string
  vramGB: number
  totalCount: number
  availableCount: number
}

export interface VesselTelemetry {
  cpu: number[]
  memory: number[]
  network: number[]
  gpu?: number[]
}

export interface WorkspaceVessel {
  id: string
  name: string
  blueprint: string
  status: 'provisioning' | 'offline' | 'starting' | 'online' | 'stopping' | 'archived' | 'error'
  ports: { name: string; port: number; protocol: 'tcp' | 'udp' }[]
  cpu?: number
  memory?: string
  gpu?: string
  telemetry?: VesselTelemetry
  volumes?: { name: string; size: string }[]
  gpuLease?: GpuLeaseState
}

export interface WorkspaceVault {
  id: string
  name: string
  type: 'clone' | 'empty'
  status: 'healthy' | 'degraded' | 'error' | 'creating' | 'snapshotting'
  usedGB: number
  totalGB: number
  attachedVessel: { name: string; id: string } | null
  mountPath: string | null
  pool: string
  lastSnapshotAt: string | null
  createdAt: string
}

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

export interface MockVaultDetail extends WorkspaceVault {
  root: MockFsNode
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

export interface FileBrowserState {
  currentPath: Ref<string>
  currentEntries: Ref<FileEntry[]>
  selectedKeys: Ref<string[]>
  focusedKey: Ref<string | null>
  isInspectorOpen: Ref<boolean>
  sortKey: Ref<FileSortKey>
  sortOrder: Ref<FileSortOrder>
  inspectorTarget: ComputedRef<FileInspectorTarget | null>
  mode: Ref<FileBrowserMode>
  openFiles: Ref<EditorTab[]>
  activeEditorTab: Ref<string | null>
  statusBarInfo: ComputedRef<{ label: string; detail: string }>
  treeExpandedKeys: Ref<string[]>
  fetchDirectory: (path?: string) => Promise<void>
  navigateTo: (path: string) => Promise<void>
  navigateUp: () => Promise<void>
  focusEntry: (path: string) => void
  clearFocus: () => void
  copyPath: () => Promise<void>
  closeInspector: () => void
  openEditor: (file: FileInspectorTarget & { type: 'file' }) => void
  closeEditor: () => void
  selectAll: () => void
  clearSelection: () => void
  updateSort: (key: FileSortKey, order: FileSortOrder) => void
  createFolder: (name: string) => Promise<void>
  renameEntry: (oldPath: string, newName: string) => Promise<void>
  deleteEntries: (paths: string[]) => Promise<void>
  init: () => void
}

/********************************************************/
