<template>
  <div class="console-tab-bar">
    <div class="tabs-container">
      <div
        v-for="tab in consoleState.tabs.value"
        :key="tab.id"
        class="console-tab"
        :class="{ 'is-active': consoleState.activeTabId.value === tab.id }"
        @click="consoleState.focusTab(tab.id)">
        <!-- Status Dot for Vessel Tabs -->
        <div v-if="tab.status" class="status-dot" :style="{ backgroundColor: getStatusColor(tab.status) }"></div>
        <!-- System Terminal Icon -->
        <icon v-else :path="mdiConsoleLine" :size="14" class="system-icon" />
        <span class="tab-label">{{ tab.label }}</span>
        <!-- Close Button -->
        <div v-if="tab.closeable" class="close-btn" @click.stop="consoleState.closeTab(tab.id)">
          <icon :path="mdiClose" :size="12" />
        </div>
      </div>
      <!-- Placeholder for future manual tab addition -->
      <div v-if="consoleState.tabs.value.length > 0" class="add-btn-placeholder">
        <n-button quaternary circle size="tiny" disabled>
          <template #icon><icon :path="mdiPlus" :size="14" /></template>
        </n-button>
      </div>
    </div>
    <div class="actions-container">
      <n-button quaternary size="small" @click="toggleExpand" class="expand-btn">
        <template #icon>
          <icon :path="consoleState.isExpanded.value ? mdiChevronDown : mdiChevronUp" :size="18" />
        </template>
        <span v-if="!consoleState.isExpanded.value" style="font-size: 12px; margin-left: 4px">Console</span>
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { NButton } from 'naive-ui'
  import { Icon } from './Icon'
  import { mdiClose, mdiChevronUp, mdiChevronDown, mdiConsoleLine, mdiPlus } from '@mdi/js'
  import { useConsole } from '../composables/useConsole'

  const consoleState = useConsole()

  function toggleExpand() {
    consoleState.isExpanded.value = !consoleState.isExpanded.value
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'online':
        return '#22c55e'
      case 'provisioning':
      case 'starting':
      case 'stopping':
        return '#f59e0b'
      case 'error':
        return '#f43f5e'
      default:
        return 'rgba(255, 255, 255, 0.25)'
    }
  }
</script>

<style scoped>
  .console-tab-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 32px;
    background-color: rgb(12, 12, 15);
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    user-select: none;
  }

  .tabs-container {
    display: flex;
    align-items: center;
    height: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs-container::-webkit-scrollbar {
    display: none;
  }

  .console-tab {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 12px;
    cursor: pointer;
    border-right: 1px solid rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.4);
    transition:
      background-color 0.2s,
      color 0.2s;
    box-sizing: border-box;
  }

  .console-tab:hover {
    background-color: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.7);
  }

  .console-tab.is-active {
    color: rgba(255, 255, 255, 0.9);
    background-color: rgba(255, 255, 255, 0.05);
    border-bottom: 2px solid var(--n-primary-color);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 8px;
  }

  .system-icon {
    margin-right: 6px;
    opacity: 0.7;
  }

  .tab-label {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    margin-left: 8px;
    opacity: 0;
    transition:
      opacity 0.2s,
      background-color 0.2s;
  }

  .console-tab:hover .close-btn,
  .console-tab.is-active .close-btn {
    opacity: 0.6;
  }

  .close-btn:hover {
    opacity: 1 !important;
    background-color: rgba(255, 255, 255, 0.1);
  }

  .add-btn-placeholder {
    padding: 0 8px;
    display: flex;
    align-items: center;
  }

  .actions-container {
    display: flex;
    align-items: center;
    padding-right: 8px;
  }

  .expand-btn {
    --n-text-color: rgba(255, 255, 255, 0.6) !important;
    --n-text-color-hover: rgba(255, 255, 255, 0.9) !important;
  }
</style>
