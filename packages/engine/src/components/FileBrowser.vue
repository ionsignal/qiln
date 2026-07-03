<template>
  <div class="file-browser-root" ref="browserRootRef" tabindex="0" @keydown="handleKeydown">
    <file-toolbar :vault-name="vault.name" />
    <div class="file-browser-main">
      <file-table />
    </div>
    <file-status-bar />
    <file-inspector :show="isInspectorOpen" @update:show="handleShow" :target="inspectorTarget" />
  </div>
</template>

<script setup lang="ts">
  import { ref } from 'vue'
  import { FileToolbar, FileTable, FileStatusBar, FileInspector } from './index'
  import { useFileBrowser } from '../composables/useFileBrowser'
  import type { FileBrowserVault } from '../types'

  defineProps<{
    vault: FileBrowserVault
  }>()

  const browserRootRef = ref<HTMLElement | null>(null)
  const {
    currentEntries,
    selectedKeys,
    inspectorTarget,
    deleteEntries,
    clearSelection,
    focusedKey,
    isInspectorOpen,
    clearFocus,
    focusEntry,
    navigateTo,
  } = useFileBrowser()

  function handleShow(val: boolean) {
    if (!val) {
      clearFocus()
      browserRootRef.value?.focus()
    }
  }

  function getFocusedIndex(): number {
    if (!focusedKey.value) return -1
    return currentEntries.value.findIndex(entry => entry.path === focusedKey.value)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedKeys.value.length > 0) {
        e.preventDefault()
        deleteEntries(selectedKeys.value)
      }
    }

    if (e.key === 'Escape') {
      if (isInspectorOpen.value) {
        isInspectorOpen.value = false
        clearFocus()
        browserRootRef.value?.focus()
      } else if (focusedKey.value) {
        clearFocus()
      } else {
        clearSelection()
      }
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      if (focusedKey.value) {
        e.preventDefault()
        isInspectorOpen.value = !isInspectorOpen.value
      }
    }

    if (e.key === 'Enter') {
      if (!focusedKey.value) return

      e.preventDefault()

      const entry = currentEntries.value.find(candidate => candidate.path === focusedKey.value)
      if (!entry) return

      if (entry.type === 'directory') {
        navigateTo(entry.path)
      } else {
        isInspectorOpen.value = true
      }
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()

      const entries = currentEntries.value
      if (entries.length === 0) return

      const idx = getFocusedIndex()
      const nextIdx = idx === -1 ? 0 : Math.min(idx + 1, entries.length - 1)
      focusEntry(entries[nextIdx].path)
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()

      const entries = currentEntries.value
      if (entries.length === 0) return

      const idx = getFocusedIndex()
      const prevIdx = idx === -1 ? entries.length - 1 : Math.max(idx - 1, 0)
      focusEntry(entries[prevIdx].path)
    }
  }
</script>

<style scoped>
  .file-browser-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--n-color);
    outline: none;
  }

  .file-browser-main {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background-color: transparent;
  }
</style>
