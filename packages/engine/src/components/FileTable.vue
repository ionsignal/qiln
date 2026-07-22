<template>
  <div class="file-table-wrapper">
    <n-data-table
      size="small"
      flex-height
      virtual-scroll
      scroll-x="100%"
      :bordered="false"
      :data="currentEntries"
      :columns="columns"
      :row-key="rowKey"
      :row-props="rowProps"
      :checked-row-keys="selectedKeys"
      @update:checked-row-keys="handleCheckedRowKeysChange"
      @update:sorter="handleSorterChange"
      @scroll="handleScroll"
      class="file-table">
      <template #empty>
        <n-empty description="This folder is empty" />
      </template>
    </n-data-table>
    <!-- Context Menu -->
    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      :show="showContextMenu"
      :on-clickoutside="closeContextMenu"
      @select="handleContextMenuSelect" />
  </div>
</template>

<script setup lang="ts">
  import { h, ref, computed } from 'vue'
  import { NDataTable, NEmpty, NDropdown } from 'naive-ui'
  import type { DataTableColumns, DataTableSortState, DropdownOption } from 'naive-ui'
  import { Icon } from './Icon'
  import { mdiDelete, mdiPencil, mdiDownload, mdiInformationOutline, mdiContentCopy } from '@mdi/js'
  import { useFileBrowser } from '../composables/useFileBrowser'
  import { formatFileSize, getFileIconPath } from '../utils/fileUtils'
  import type { FileEntry, FileSortKey } from '../types'

  const {
    currentEntries,
    selectedKeys,
    sortKey,
    sortOrder,
    navigateTo,
    updateSort,
    deleteEntries,
    focusedKey,
    isInspectorOpen,
    focusEntry,
    copyPath,
  } = useFileBrowser()

  const showContextMenu = ref(false)
  const contextMenuX = ref(0)
  const contextMenuY = ref(0)
  const contextMenuTarget = ref<FileEntry | null>(null)
  const rowKey = (row: FileEntry) => row.path

  const columns = computed<DataTableColumns<FileEntry>>(() => [
    {
      type: 'selection',
      width: 32,
    },
    {
      title: 'Name',
      key: 'name',
      sorter: true,
      sortOrder: sortKey.value === 'name' ? sortOrder.value : false,
      render(row) {
        const iconPath = getFileIconPath(row)
        const isDir = row.type === 'directory'
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          h(Icon, {
            path: iconPath,
            size: 18,
            style: { color: isDir ? '#3b82f6' : 'inherit', opacity: isDir ? 0.9 : 0.6 },
          }),
          h('span', { style: { fontWeight: isDir ? 600 : 400 } }, row.name),
        ])
      },
    },
    {
      title: 'Size',
      key: 'size',
      sorter: true,
      width: 120,
      sortOrder: sortKey.value === 'size' ? sortOrder.value : false,
      render(row) {
        if (row.type === 'file') {
          return h('span', { class: 'file-meta-cell' }, formatFileSize(row.size))
        }
        return h('span', { class: 'file-meta-cell' }, '--')
      },
    },
    {
      title: 'Modified',
      key: 'modified',
      sorter: true,
      width: 180,
      sortOrder: sortKey.value === 'modified' ? sortOrder.value : false,
      render(row) {
        const date = new Date(row.modified)
        return h(
          'span',
          { class: 'file-meta-cell' },
          date.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        )
      },
    },
  ])

  const rowProps = computed(() => {
    const currentFocus = focusedKey.value
    return (row: FileEntry) => ({
      style: { cursor: 'pointer' },
      class: currentFocus === row.path ? 'file-row--focused' : '',
      onClick: (e: MouseEvent) => {
        if ((e.target as Element | null)?.closest('.n-checkbox')) return
        focusEntry(row.path)
        isInspectorOpen.value = true
      },
      onDblclick: (e: MouseEvent) => {
        if ((e.target as Element | null)?.closest('.n-checkbox')) return
        if (row.type === 'directory') {
          navigateTo(row.path)
        }
      },
      onContextmenu: (e: MouseEvent) => {
        e.preventDefault()
        focusEntry(row.path)
        showContextMenu.value = true
        contextMenuX.value = e.clientX
        contextMenuY.value = e.clientY
        contextMenuTarget.value = row
        if (!selectedKeys.value.includes(row.path)) {
          selectedKeys.value = [row.path]
        }
      },
    })
  })

  function handleCheckedRowKeysChange(keys: Array<string | number>) {
    selectedKeys.value = keys as string[]
  }

  function handleSorterChange(sorter: DataTableSortState | null) {
    if (!sorter || !sorter.order) {
      updateSort('name', 'ascend')
      return
    }
    updateSort(sorter.columnKey as FileSortKey, sorter.order)
  }

  function handleScroll() {
    if (showContextMenu.value) closeContextMenu()
  }

  function closeContextMenu() {
    showContextMenu.value = false
    contextMenuTarget.value = null
  }

  const contextMenuOptions = computed<DropdownOption[]>(() => [
    { label: 'Inspect', key: 'inspect', icon: () => h(Icon, { path: mdiInformationOutline, size: 16 }) },
    { label: 'Copy Path', key: 'copy-path', icon: () => h(Icon, { path: mdiContentCopy, size: 16 }) },
    { label: 'Download', key: 'download', icon: () => h(Icon, { path: mdiDownload, size: 16 }) },
    { label: 'Rename', key: 'rename', icon: () => h(Icon, { path: mdiPencil, size: 16 }) },
    { type: 'divider', key: 'd1' },
    {
      label: 'Delete',
      key: 'delete',
      icon: () => h(Icon, { path: mdiDelete, size: 16, style: 'color: var(--n-error-color)' }),
    },
  ])

  function handleContextMenuSelect(key: string) {
    closeContextMenu()
    if (key === 'inspect' && contextMenuTarget.value) {
      focusEntry(contextMenuTarget.value.path)
      isInspectorOpen.value = true
    } else if (key === 'copy-path') {
      copyPath()
    } else if (key === 'delete') {
      deleteEntries(selectedKeys.value)
    } else if (key === 'rename' && contextMenuTarget.value) {
      console.log('Rename triggered for:', contextMenuTarget.value.path)
    } else if (key === 'download' && contextMenuTarget.value) {
      console.log('Download triggered for:', contextMenuTarget.value.path)
    }
  }
</script>

<style scoped>
  .file-table-wrapper {
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .file-table {
    flex: 1;
    min-height: 0;
  }

  .file-meta-cell {
    color: var(--n-td-text-color);
    opacity: 0.6;
    font-size: 12px;
  }

  :deep(.n-data-table-tr) {
    user-select: none;
    background-color: transparent;
  }

  :deep(.file-row--focused td) {
    background-color: rgba(255, 255, 255, 0.06) !important;
  }
</style>
