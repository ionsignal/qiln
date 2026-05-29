<template>
  <n-drawer
    class="qiln-instant-drawer"
    :show="show"
    :width="380"
    placement="right"
    :show-mask="false"
    :trap-focus="false"
    :block-scroll="false"
    :mask-closable="false"
    :auto-focus="false"
    @update:show="handleUpdateShow">
    <n-drawer-content closable body-content-style="height: 100%; display: flex; flex-direction: column; padding: 0;">
      <!-- Header -->
      <template #header>
        <n-flex vertical :size="4" v-if="target">
          <n-flex align="center" :size="8">
            <icon :path="iconPath" :size="20" :style="{ color: target.type === 'directory' ? '#3b82f6' : 'inherit' }" />
            <n-text style="font-weight: 600; font-size: 16px; letter-spacing: 0.02em; word-break: break-all">
              {{ target.name }}
            </n-text>
            <n-tag v-if="target.type === 'file'" size="small" :bordered="false" type="default" round>
              {{ target.extension || 'file' }}
            </n-tag>
            <n-tag v-else size="small" :bordered="false" type="info" round>Directory</n-tag>
          </n-flex>
          <n-text depth="3" style="font-size: 12px; word-break: break-all">{{ target.path }}</n-text>
        </n-flex>
      </template>
      <!-- Scrollable Body -->
      <div v-if="target" class="drawer-body">
        <div class="drawer-scroll-area">
          <!-- Metadata -->
          <n-descriptions :column="1" label-placement="left" size="small" :bordered="false" class="vessel-meta">
            <template v-if="target.type === 'file'">
              <n-descriptions-item label="Size">{{ formatFileSize(target.size) }}</n-descriptions-item>
              <n-descriptions-item label="Type">{{ target.fileType }}</n-descriptions-item>
            </template>
            <template v-else>
              <n-descriptions-item label="Contents">{{ target.childCount }} items</n-descriptions-item>
            </template>
            <n-descriptions-item label="Modified">{{ formattedDate }}</n-descriptions-item>
          </n-descriptions>
          <!-- Action Bar -->
          <n-flex justify="space-between" align="center" class="action-bar">
            <n-button-group>
              <n-tooltip trigger="hover" placement="bottom" v-if="target.type === 'file' && ['text', 'config'].includes(target.fileType)">
                <template #trigger>
                  <n-button secondary type="info" size="small" @click="handleEdit">
                    <template #icon><icon :path="mdiPencil" /></template>
                  </n-button>
                </template>
                Edit File
              </n-tooltip>
              <n-tooltip trigger="hover" placement="bottom" v-if="target.type === 'file'">
                <template #trigger>
                  <n-button secondary type="info" size="small" @click="handleDownload">
                    <template #icon><icon :path="mdiDownload" /></template>
                  </n-button>
                </template>
                Download
              </n-tooltip>
              <n-tooltip trigger="hover" placement="bottom">
                <template #trigger>
                  <n-button secondary type="info" size="small" @click="handleRename">
                    <template #icon><icon :path="mdiCursorText" /></template>
                  </n-button>
                </template>
                Rename
              </n-tooltip>
            </n-button-group>
            <n-popconfirm @positive-click="handleDelete" :positive-button-props="{ type: 'error' }">
              <template #trigger>
                <n-tooltip trigger="hover" placement="bottom">
                  <template #trigger>
                    <n-button secondary type="error" size="small">
                      <template #icon><icon :path="mdiDelete" /></template>
                    </n-button>
                  </template>
                  Delete
                </n-tooltip>
              </template>
              Are you sure you want to delete this {{ target.type }}?
            </n-popconfirm>
          </n-flex>
          <n-divider style="margin: 16px 0 8px 0" />
          <!-- Preview Section -->
          <n-collapse v-model:expanded-names="expandedNames">
            <n-collapse-item title="Preview" name="preview">
              <!-- Type Narrowing Guard -->
              <template v-if="target.type === 'file'">
                <file-preview-content :target="target" />
              </template>
              <template v-else>
                <div class="directory-preview">
                  <n-text depth="3" style="font-size: 12px">Directory contains {{ target.childCount }} items.</n-text>
                </div>
              </template>
            </n-collapse-item>
          </n-collapse>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
  import { ref, computed, watch } from 'vue'
  import {
    NDrawer,
    NDrawerContent,
    NFlex,
    NText,
    NTag,
    NDescriptions,
    NDescriptionsItem,
    NButton,
    NButtonGroup,
    NTooltip,
    NCollapse,
    NCollapseItem,
    NDivider,
    NPopconfirm,
    useMessage,
  } from 'naive-ui'
  import { Icon } from './Icon'
  import FilePreviewContent from './FilePreviewContent.vue'
  import { mdiPencil, mdiDownload, mdiCursorText, mdiDelete } from '@mdi/js'
  import { getFileIconPath, formatFileSize } from '../utils/fileUtils'
  import { useFileBrowser } from '../composables/useFileBrowser'
  import type { FileInspectorTarget, FileEntry } from '../types'

  const props = defineProps<{
    show: boolean
    target: FileInspectorTarget | null
  }>()

  const emit = defineEmits<{
    (e: 'update:show', value: boolean): void
  }>()

  const message = useMessage()
  const { openEditor, deleteEntries } = useFileBrowser()
  const expandedNames = ref<string[]>(['preview'])

  watch(
    () => props.target,
    (newTarget, oldTarget) => {
      if (!newTarget && oldTarget && props.show) {
        emit('update:show', false)
      }
    },
  )

  function handleUpdateShow(val: boolean) {
    if (!val) {
      emit('update:show', val)
    }
  }

  const formattedDate = computed(() => {
    if (!props.target) return ''
    return new Date(props.target.modified).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  })

  const iconPath = computed(() => {
    if (!props.target) return ''
    return getFileIconPath(props.target as unknown as FileEntry)
  })

  function handleEdit() {
    if (props.target?.type === 'file') {
      openEditor(props.target)
    }
  }

  function handleDownload() {
    message.info('Downloads will use the Sidecar Architecture.')
  }

  function handleRename() {
    console.log(`[FileInspector] Rename stub for: ${props.target?.path}`)
    message.info('Rename functionality coming soon.')
  }

  async function handleDelete() {
    if (!props.target) return
    await deleteEntries([props.target.path])
    emit('update:show', false)
  }
</script>

<style>
  .qiln-instant-drawer {
    transition-duration: 0s !important;
  }
  .slide-in-from-right-transition-enter-active.qiln-instant-drawer,
  .slide-in-from-right-transition-leave-active.qiln-instant-drawer {
    transition-duration: 0s !important;
  }
</style>

<style scoped>
  .drawer-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    height: 100%;
    position: relative;
  }

  .drawer-scroll-area {
    height: 100%;
    overflow-y: auto;
    padding: 24px;
    padding-bottom: 160px;
  }

  .vessel-meta {
    margin-bottom: 16px;
  }

  .action-bar {
    margin-bottom: 0;
  }

  .directory-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    background-color: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--n-border-color);
    border-radius: 6px;
  }
</style>
