<template>
  <div class="file-preview-content">
    <n-scrollbar style="max-height: 400px" trigger="none">
      <div v-if="['text', 'config'].includes(target.fileType)" class="code-preview">
        <n-code :code="truncatedContent" :language="language" word-wrap />
      </div>
      <div v-else-if="target.fileType === 'image'" class="empty-preview">
        <n-empty description="Image preview coming soon">
          <template #icon><icon :path="mdiImage" /></template>
        </n-empty>
      </div>
      <div v-else-if="target.fileType === 'archive'" class="empty-preview">
        <n-empty description="Archive contents preview not available">
          <template #icon><icon :path="mdiZipBox" /></template>
        </n-empty>
      </div>
      <div v-else-if="target.fileType === 'binary'" class="empty-preview">
        <n-empty description="Binary file — no preview available">
          <template #icon><icon :path="mdiFileOutline" /></template>
        </n-empty>
      </div>
      <div v-else class="empty-preview">
        <n-empty description="Unknown file type">
          <template #icon><icon :path="mdiFileQuestion" /></template>
        </n-empty>
      </div>
    </n-scrollbar>
  </div>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { NCode, NEmpty, NScrollbar } from 'naive-ui'
  import { Icon } from './Icon'
  import { mdiImage, mdiZipBox, mdiFileOutline, mdiFileQuestion } from '@mdi/js'
  import { getFileLanguage } from '../utils/fileUtils'
  import type { FileInspectorTarget } from '../types'

  const props = defineProps<{
    target: FileInspectorTarget & { type: 'file' }
  }>()

  const language = computed(() => getFileLanguage(props.target.name))
  const truncatedContent = computed(() => {
    if (!props.target.content) return ''
    const lines = props.target.content.split('\n')
    if (lines.length > 50) {
      return lines.slice(0, 50).join('\n') + '\n\n... [Showing first 50 lines. Download to view full file.]'
    }
    return props.target.content
  })
</script>

<style scoped>
  .file-preview-content {
    background-color: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--n-border-color);
    border-radius: 6px;
    overflow: hidden;
  }

  .code-preview {
    padding: 12px;
    font-size: 12px;
  }

  .empty-preview {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    opacity: 0.7;
  }
</style>
