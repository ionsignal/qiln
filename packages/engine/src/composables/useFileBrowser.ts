import { ref, shallowRef, computed, provide, inject, watch, type InjectionKey, type Ref } from 'vue'
import { resolveDirectory, resolveFileMetadata } from '../utils/mockFilesystem'
import { getFileType, formatFileSize } from '../utils/fileUtils'
import { useMessage } from 'naive-ui'
import type {
  FileEntry,
  FileSortKey,
  FileSortOrder,
  MockVaultDetail,
  FileInspectorTarget,
  FileBrowserMode,
  EditorTab,
  FileBrowserState,
} from '../types'

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

export function provideFileBrowser(options: { vault: Ref<MockVaultDetail>; initialPath?: string }): FileBrowserState {
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
    const entry = currentEntries.value.find(e => e.path === focusedKey.value)
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
    } else {
      return {
        type: 'directory',
        path: entry.path,
        name: entry.name,
        modified: entry.modified,
        childCount: entry.childCount,
      }
    }
  })

  const statusBarInfo = computed(() => {
    const keys = selectedKeys.value
    if (keys.length === 0) {
      if (focusedKey.value) {
        const entry = currentEntries.value.find(e => e.path === focusedKey.value)
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
      const entry = currentEntries.value.find(e => e.path === keys[0])
      if (!entry) return { label: '1 item selected', detail: '' }
      const date = new Date(entry.modified).toLocaleString()
      if (entry.type === 'file') {
        return { label: entry.name, detail: `${formatFileSize(entry.size)} · ${date}` }
      }
      return { label: entry.name, detail: date }
    }
    const totalSize = currentEntries.value
      .filter(e => keys.includes(e.path) && e.type === 'file')
      .reduce((acc, e) => acc + (e as Extract<FileEntry, { type: 'file' }>).size, 0)
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
      fetchDirectory()
    },
  )

  async function fetchDirectory(path: string = currentPath.value) {
    await new Promise(r => setTimeout(r, 50))
    const rawEntries = resolveDirectory(options.vault.value, path)
    currentEntries.value = sortEntries([...rawEntries], sortKey.value, sortOrder.value)
  }

  async function navigateTo(path: string) {
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

  async function navigateUp() {
    if (currentPath.value === '/') return
    const segments = currentPath.value.split('/').filter(Boolean)
    segments.pop()
    const parentPath = segments.length === 0 ? '/' : '/' + segments.join('/')
    await navigateTo(parentPath)
  }

  function focusEntry(path: string) {
    focusedKey.value = path
  }

  function clearFocus() {
    focusedKey.value = null
    isInspectorOpen.value = false
  }

  async function copyPath() {
    if (!focusedKey.value) return
    if (!navigator?.clipboard) {
      message.error('Clipboard API not available in this context')
      return
    }
    try {
      await navigator.clipboard.writeText(focusedKey.value)
      message.success('Path copied to clipboard')
    } catch (err) {
      message.error('Failed to copy path')
    }
  }

  function closeInspector() {
    clearFocus()
  }

  function openEditor(file: FileInspectorTarget & { type: 'file' }) {
    console.log(`[FileBrowser] Editor stub: ${file.path}`)
    message.info('Editor mode coming soon.')
  }

  function closeEditor() {
    mode.value = 'browsing'
    openFiles.value = []
    activeEditorTab.value = null
  }

  function selectAll() {
    selectedKeys.value = currentEntries.value.map(e => e.path)
  }

  function clearSelection() {
    selectedKeys.value = []
  }

  function updateSort(key: FileSortKey, order: FileSortOrder) {
    sortKey.value = key
    sortOrder.value = order
    currentEntries.value = sortEntries([...currentEntries.value], key, order)
  }

  async function createFolder(name: string) {
    console.log(`[Mock] Creating folder ${name} at ${currentPath.value}`)
    await fetchDirectory()
  }

  async function renameEntry(oldPath: string, newName: string) {
    console.log(`[Mock] Renaming ${oldPath} to ${newName}`)
    await fetchDirectory()
  }

  async function deleteEntries(paths: string[]) {
    console.log(`[Mock] Deleting ${paths.length} entries`)
    if (focusedKey.value && paths.includes(focusedKey.value)) {
      clearFocus()
    }
    clearSelection()
    await fetchDirectory()
  }

  function init() {
    fetchDirectory().catch(e => console.error('[FileBrowser] Init fetch failed', e))
  }

  const state: FileBrowserState = {
    currentPath,
    currentEntries,
    selectedKeys,
    focusedKey,
    isInspectorOpen,
    sortKey,
    sortOrder,
    inspectorTarget,
    mode,
    openFiles,
    activeEditorTab,
    statusBarInfo,
    treeExpandedKeys,
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
