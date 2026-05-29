<template>
  <n-flex justify="space-between" align="center" class="file-toolbar">
    <!-- Left: Breadcrumb Navigation -->
    <n-breadcrumb>
      <n-breadcrumb-item v-for="crumb in breadcrumbs" :key="crumb.path" @click="navigateTo(crumb.path)">
        <span style="display: inline-flex; align-items: center; gap: 4px; cursor: pointer">
          <icon v-if="crumb.path === '/'" :path="mdiHarddisk" :size="16" style="opacity: 0.7" />
          <span>{{ crumb.label }}</span>
        </span>
      </n-breadcrumb-item>
    </n-breadcrumb>
    <!-- Right: Actions -->
    <n-flex align="center" :size="8">
      <n-button-group>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <n-button size="small" secondary @click="handleUploadStub">
              <template #icon><icon :path="mdiUpload" /></template>
            </n-button>
          </template>
          Upload Files (Coming Soon)
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <n-button size="small" secondary @click="showNewFolderModal = true">
              <template #icon><icon :path="mdiFolderPlus" /></template>
            </n-button>
          </template>
          New Folder
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <n-button size="small" secondary @click="handleSnapshotStub">
              <template #icon><icon :path="mdiCameraIris" /></template>
            </n-button>
          </template>
          Take Snapshot (Coming Soon)
        </n-tooltip>
      </n-button-group>
      <!-- More Actions Dropdown -->
      <n-dropdown placement="bottom-end" :options="moreOptions" @select="handleMoreSelect">
        <n-button size="small" secondary>
          <template #icon><icon :path="mdiDotsVertical" /></template>
        </n-button>
      </n-dropdown>
    </n-flex>
    <n-modal v-model:show="showNewFolderModal">
      <n-card style="width: 400px" title="Create New Folder" :bordered="false" size="small" role="dialog" aria-modal="true">
        <n-input v-model:value="newFolderName" placeholder="Folder name..." @keydown.enter="handleCreateFolder" autofocus />
        <template #action>
          <n-flex justify="flex-end" :size="8">
            <n-button size="small" @click="showNewFolderModal = false">Cancel</n-button>
            <n-button size="small" type="primary" :disabled="!newFolderName.trim()" @click="handleCreateFolder">Create</n-button>
          </n-flex>
        </template>
      </n-card>
    </n-modal>
  </n-flex>
</template>

<script setup lang="ts">
  import { ref, computed, h } from 'vue'
  import { NFlex, NBreadcrumb, NBreadcrumbItem, NButtonGroup, NButton, NTooltip, NDropdown, NModal, NCard, NInput, useMessage } from 'naive-ui'
  import type { DropdownOption } from 'naive-ui'
  import { Icon } from './Icon'
  import { mdiUpload, mdiFolderPlus, mdiCameraIris, mdiDotsVertical, mdiHarddisk, mdiCheckAll, mdiDelete } from '@mdi/js'
  import { useFileBrowser } from '../composables/useFileBrowser'

  const props = defineProps<{
    vaultName: string
  }>()

  const { currentPath, selectedKeys, navigateTo, selectAll, deleteEntries, createFolder } = useFileBrowser()
  const message = useMessage()
  const showNewFolderModal = ref(false)
  const newFolderName = ref('')

  const breadcrumbs = computed(() => {
    const segments = currentPath.value.split('/').filter(Boolean)
    const crumbs = []
    let accum = ''
    crumbs.push({ label: props.vaultName, path: '/' })
    for (const seg of segments) {
      accum += `/${seg}`
      crumbs.push({ label: seg, path: accum })
    }
    return crumbs
  })

  const moreOptions = computed<DropdownOption[]>(() => {
    const hasSelection = selectedKeys.value.length > 0
    return [
      { label: 'Select All', key: 'select-all', icon: () => h(Icon, { path: mdiCheckAll, size: 16 }) },
      { type: 'divider', key: 'd1' },
      {
        label: 'Delete Selected',
        key: 'delete-selected',
        disabled: !hasSelection,
        icon: () => h(Icon, { path: mdiDelete, size: 16, style: hasSelection ? 'color: var(--n-error-color)' : '' }),
      },
    ]
  })

  function handleMoreSelect(key: string) {
    if (key === 'select-all') selectAll()
    else if (key === 'delete-selected') deleteEntries(selectedKeys.value)
  }

  async function handleCreateFolder() {
    const name = newFolderName.value.trim()
    if (!name) return
    await createFolder(name)
    message.success(`Folder '${name}' created`)
    newFolderName.value = ''
    showNewFolderModal.value = false
  }

  function handleUploadStub() {
    message.info('File uploads will be handled via the Sidecar Architecture.')
  }

  function handleSnapshotStub() {
    message.info('ZFS Snapshots coming soon.')
  }
</script>

<style scoped>
  .file-toolbar {
    height: 48px;
    padding: 0;
    background-color: var(--n-color);
    border-bottom: 1px solid var(--n-border-color);
  }
</style>
