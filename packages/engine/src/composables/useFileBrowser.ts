import { ref, shallowRef, computed, provide, inject, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import { resolveDirectory, resolveFileMetadata } from '../utils/mockFilesystem'
import { getFileType, formatFileSize } from '../utils/fileUtils'
import { useMessage } from 'naive-ui'
import type { EditorTab, FileBrowserMode, FileBrowserVault, FileEntry, FileInspectorTarget, FileSortKey, FileSortOrder } from '../types'

export interface FileBrowserStatusBarInfo {
  label: string
  detail: string
}

type FileBrowserEditableTarget = Extract<FileInspectorTarget, { type: 'file' }>

export interface FileBrowserProviderOptions {
  vault: Ref<FileBrowserVault>
  initialPath?: string
}

export interface FileBrowserState {
  currentPath: Ref<string>
  currentEntries: Ref<FileEntry[]>
  selectedKeys: Ref<string[]>
  focusedKey: Ref<string | null>
  isInspectorOpen: Ref<boolean>
  sortKey: Ref<FileSortKey>
  sortOrder: Ref<FileSortOrder>
  treeExpandedKeys: Ref<string[]>
  mode: Ref<FileBrowserMode>
  openFiles: Ref<EditorTab[]>
  activeEditorTab: Ref<string | null>
  inspectorTarget: ComputedRef<FileInspectorTarget | null>
  statusBarInfo: ComputedRef<FileBrowserStatusBarInfo>
  fetchDirectory: (path?: string) => Promise<void>
  navigateTo: (path: string) => Promise<void>
  navigateUp: () => Promise<void>
  focusEntry: (path: string) => void
  clearFocus: () => void
  copyPath: () => Promise<void>
  closeInspector: () => void
  openEditor: (file: FileBrowserEditableTarget) => void
  closeEditor: () => void
  selectAll: () => void
  clearSelection: () => void
  updateSort: (key: FileSortKey, order: FileSortOrder) => void
  createFolder: (name: string) => Promise<void>
  renameEntry: (oldPath: string, newName: string) => Promise<void>
  deleteEntries: (paths: string[]) => Promise<void>
  init: () => void
}

const FileBrowserInjectionKey: InjectionKey<FileBrowserState> = Symbol('QilnFileBrowser')

function sortEntries(entries: FileEntry[], key: FileSortKey, order: FileSortOrder): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.type === 'directory' && b.type === 'file') return -1
    if (a.type === 'file' && b.type === 'directory') return 1
    let cmp = 0
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name)
    } else if (key === 'size') {
      const sizeA = a.type === 'file' ? a.size : 0
      const sizeB = b.type === 'file' ? b.size : 0
      cmp = sizeA - sizeB
    } else if (key === 'modified') {
      cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime()
    } else if (key === 'type') {
      const typeA = a.type === 'file' ? a.extension : 'dir'
      const typeB = b.type === 'file' ? b.extension : 'dir'
      cmp = typeA.localeCompare(typeB)
    }
    return order === 'ascend' ? cmp : -cmp
  })
}

export function provideFileBrowser(options: FileBrowserProviderOptions): FileBrowserState {
  const message = useMessage()
  const currentPath = ref(options.initialPath ?? '/')
  const currentEntries = shallowRef<FileEntry[]>([])
  const selectedKeys = ref<string[]>([])
  const focusedKey = ref<string | null>(null)
  const isInspectorOpen = ref(false)
  const sortKey = ref<FileSortKey>('name')
  const sortOrder = ref<FileSortOrder>('ascend')
  const treeExpandedKeys = ref<string[]>(['/'])
  const mode = ref<FileBrowserMode>('browsing')
  const openFiles = ref<EditorTab[]>([])
  const activeEditorTab = ref<string | null>(null)

  const inspectorTarget = computed<FileInspectorTarget | null>(() => {
    if (!focusedKey.value) return null
    const entry = currentEntries.value.find(fileEntry => fileEntry.path === focusedKey.value)
    if (!entry) return null
    const node = resolveFileMetadata(options.vault.value, entry.path)
    if (!node) return null
    if (entry.type === 'file') {
      return {
        type: 'file',
        path: entry.path,
        name: entry.name,
        size: entry.size,
        modified: entry.modified,
        extension: entry.extension,
        content: node.content ?? null,
        fileType: getFileType(entry.name),
      }
    }
    return {
      type: 'directory',
      path: entry.path,
      name: entry.name,
      modified: entry.modified,
      childCount: entry.childCount,
    }
  })

  const statusBarInfo = computed<FileBrowserStatusBarInfo>(() => {
    const keys = selectedKeys.value
    if (keys.length === 0) {
      if (focusedKey.value) {
        const entry = currentEntries.value.find(fileEntry => fileEntry.path === focusedKey.value)
        if (entry) {
          const date = new Date(entry.modified).toLocaleString()
          if (entry.type === 'file') {
            return { label: entry.name, detail: `${formatFileSize(entry.size)} · ${date}` }
          }
          return { label: entry.name, detail: date }
        }
      }
      const count = currentEntries.value.length
      return { label: `${count} item${count === 1 ? '' : 's'}`, detail: '' }
    }
    if (keys.length === 1) {
      const entry = currentEntries.value.find(fileEntry => fileEntry.path === keys[0])

      if (!entry) {
        return { label: '1 item selected', detail: '' }
      }
      const date = new Date(entry.modified).toLocaleString()
      if (entry.type === 'file') {
        return { label: entry.name, detail: `${formatFileSize(entry.size)} · ${date}` }
      }
      return { label: entry.name, detail: date }
    }
    const totalSize = currentEntries.value
      .filter(entry => keys.includes(entry.path) && entry.type === 'file')
      .reduce((acc, entry) => acc + (entry.type === 'file' ? entry.size : 0), 0)
    return { label: `${keys.length} items selected`, detail: formatFileSize(totalSize) }
  })

  watch(
    () => currentPath.value,
    () => {
      closeInspector()
    },
  )

  watch(
    () => mode.value,
    newMode => {
      if (newMode === 'editing') {
        closeInspector()
      }
    },
  )

  watch(
    () => options.vault.value.id,
    () => {
      currentPath.value = '/'
      selectedKeys.value = []
      clearFocus()
      treeExpandedKeys.value = ['/']
      fetchDirectory().catch(error => console.error('[FileBrowser] Failed to refresh after vault change:', error))
    },
  )

  async function fetchDirectory(path: string = currentPath.value): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 50))
    const rawEntries = resolveDirectory(options.vault.value, path)
    currentEntries.value = sortEntries([...rawEntries], sortKey.value, sortOrder.value)
  }

  async function navigateTo(path: string): Promise<void> {
    currentPath.value = path
    selectedKeys.value = []
    clearFocus()
    const segments = path.split('/').filter(Boolean)
    let accum = ''
    const keysToAdd = ['/']
    for (const seg of segments) {
      accum += `/${seg}`
      keysToAdd.push(accum)
    }
    treeExpandedKeys.value = Array.from(new Set([...treeExpandedKeys.value, ...keysToAdd]))
    await fetchDirectory(path)
  }

  async function navigateUp(): Promise<void> {
    if (currentPath.value === '/') return
    const segments = currentPath.value.split('/').filter(Boolean)
    segments.pop()
    const parentPath = segments.length === 0 ? '/' : `/${segments.join('/')}`
    await navigateTo(parentPath)
  }

  function focusEntry(path: string): void {
    focusedKey.value = path
  }

  function clearFocus(): void {
    focusedKey.value = null
    isInspectorOpen.value = false
  }

  async function copyPath(): Promise<void> {
    if (!focusedKey.value) return
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      message.error('Clipboard API not available in this context')
      return
    }
    try {
      await navigator.clipboard.writeText(focusedKey.value)
      message.success('Path copied to clipboard')
    } catch {
      message.error('Failed to copy path')
    }
  }

  function closeInspector(): void {
    clearFocus()
  }

  function openEditor(file: FileBrowserEditableTarget): void {
    console.log(`[FileBrowser] Editor stub: ${file.path}`)
    message.info('Editor mode coming soon.')
  }

  function closeEditor(): void {
    mode.value = 'browsing'
    openFiles.value = []
    activeEditorTab.value = null
  }

  function selectAll(): void {
    selectedKeys.value = currentEntries.value.map(entry => entry.path)
  }

  function clearSelection(): void {
    selectedKeys.value = []
  }

  function updateSort(key: FileSortKey, order: FileSortOrder): void {
    sortKey.value = key
    sortOrder.value = order
    currentEntries.value = sortEntries([...currentEntries.value], key, order)
  }

  async function createFolder(name: string): Promise<void> {
    console.log(`[Mock] Creating folder ${name} at ${currentPath.value}`)
    await fetchDirectory()
  }

  async function renameEntry(oldPath: string, newName: string): Promise<void> {
    console.log(`[Mock] Renaming ${oldPath} to ${newName}`)
    await fetchDirectory()
  }

  async function deleteEntries(paths: string[]): Promise<void> {
    console.log(`[Mock] Deleting ${paths.length} entries`)
    if (focusedKey.value && paths.includes(focusedKey.value)) {
      clearFocus()
    }
    clearSelection()
    await fetchDirectory()
  }

  function init(): void {
    fetchDirectory().catch(error => console.error('[FileBrowser] Init fetch failed', error))
  }

  const state: FileBrowserState = {
    currentPath,
    currentEntries,
    selectedKeys,
    focusedKey,
    isInspectorOpen,
    sortKey,
    sortOrder,
    treeExpandedKeys,
    mode,
    openFiles,
    activeEditorTab,
    inspectorTarget,
    statusBarInfo,
    fetchDirectory,
    navigateTo,
    navigateUp,
    focusEntry,
    clearFocus,
    copyPath,
    closeInspector,
    openEditor,
    closeEditor,
    selectAll,
    clearSelection,
    updateSort,
    createFolder,
    renameEntry,
    deleteEntries,
    init,
  }
  provide(FileBrowserInjectionKey, state)
  return state
}

export function useFileBrowser(): FileBrowserState {
  const state = inject(FileBrowserInjectionKey)
  if (!state) {
    throw new Error('useFileBrowser must be used within a component that calls provideFileBrowser()')
  }
  return state
}
