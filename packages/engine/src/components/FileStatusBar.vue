<template>
  <div class="file-status-bar">
    <div class="status-left">
      <span>{{ statusBarInfo.label }}</span>
    </div>
    <div class="status-right">
      <span>{{ statusBarInfo.detail }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { useFileBrowser } from '../composables/useFileBrowser'

  const { statusBarInfo } = useFileBrowser()
</script>

<style scoped>
  .file-status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 32px;
    padding: 0 16px;
    background-color: var(--n-color);
    border-top: 1px solid var(--n-border-color);
    font-family: 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    user-select: none;
    flex-shrink: 0;
  }

  .status-left,
  .status-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
</style>
