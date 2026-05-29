<template>
  <n-el
    tag="div"
    class="compact-vault-tile"
    :class="{ 'is-selected': selected }"
    role="button"
    tabindex="0"
    @click="$emit('select')"
    @dblclick="$emit('inspect')"
    @keydown.enter="$emit('select')">
    <div class="status-stripe" :style="{ backgroundColor: statusColor }"></div>
    <div class="tile-content">
      <div class="vault-name">{{ vault.name }}</div>
      <n-flex align="center" :size="6" class="vault-meta-row">
        <n-tag size="small" :bordered="false" :type="vault.type === 'clone' ? 'info' : 'default'">
          {{ vault.type }}
        </n-tag>
        <n-text depth="3" style="font-size: 11px">{{ vault.pool }}</n-text>
      </n-flex>
      <div v-if="vault.attachedVessel" class="vault-attached">
        <icon :path="mdiLink" :size="11" style="opacity: 0.4; flex-shrink: 0" />
        <n-text depth="3" style="font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
          {{ vault.attachedVessel.name }}
        </n-text>
        <n-text v-if="vault.mountPath" depth="3" style="font-size: 10px; opacity: 0.5; flex-shrink: 0">
          {{ vault.mountPath }}
        </n-text>
      </div>
      <n-text v-else depth="3" style="font-size: 11px; font-style: italic; margin-top: 2px">Unattached</n-text>
    </div>
    <div class="tile-right-zone">
      <div class="zone-row-top">
        <n-text style="font-size: 12px; font-weight: 600">{{ usageLabel }}</n-text>
        <n-text :depth="3" style="font-size: 11px">{{ usagePercentage }}%</n-text>
      </div>
      <div class="zone-row-middle">
        <n-progress type="line" :percentage="usagePercentage" :color="usageBarColor" :height="4" :show-indicator="false" />
        <n-text v-if="vault.lastSnapshotAt" :depth="3" class="snapshot-label">
          <icon :path="mdiCameraIris" :size="10" style="vertical-align: -1px; margin-right: 2px" />
          {{ snapshotLabel }}
        </n-text>
        <n-text v-else :depth="3" class="snapshot-label" style="font-style: italic">No snapshots</n-text>
      </div>
      <div class="zone-row-bottom">
        <n-flex :size="0" align="center" class="action-group">
          <n-tooltip trigger="hover" placement="top">
            <template #trigger>
              <n-button size="tiny" quaternary type="info" :disabled="isProcessing" @click.stop="$emit('browse')">
                <template #icon><icon :path="mdiFolderOpen" /></template>
              </n-button>
            </template>
            Browse Files
          </n-tooltip>
          <n-tooltip trigger="hover" placement="top">
            <template #trigger>
              <n-button
                size="tiny"
                quaternary
                type="info"
                :disabled="isProcessing || vault.status === 'snapshotting'"
                @click.stop="$emit('snapshot')">
                <template #icon><icon :path="mdiCameraIris" /></template>
              </n-button>
            </template>
            Snapshot
          </n-tooltip>
          <n-tooltip trigger="hover" placement="top">
            <template #trigger>
              <n-button size="tiny" quaternary type="info" @click.stop="$emit('inspect')">
                <template #icon><icon :path="mdiCog" /></template>
              </n-button>
            </template>
            Settings
          </n-tooltip>
        </n-flex>
      </div>
    </div>
  </n-el>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { NEl, NButton, NFlex, NTooltip, NTag, NText, NProgress } from 'naive-ui'
  import { Icon } from './Icon'
  import { mdiLink, mdiFolderOpen, mdiCameraIris, mdiCog } from '@mdi/js'
  import type { WorkspaceVault } from '../types'

  const props = defineProps<{
    vault: WorkspaceVault
    selected?: boolean
  }>()

  defineEmits<{
    (e: 'select'): void
    (e: 'inspect'): void
    (e: 'browse'): void
    (e: 'snapshot'): void
  }>()

  const isProcessing = computed(() => {
    return ['creating', 'snapshotting'].includes(props.vault.status)
  })

  const statusColor = computed(() => {
    switch (props.vault.status) {
      case 'healthy':
        return 'var(--success-color)'
      case 'creating':
      case 'snapshotting':
        return 'var(--warning-color)'
      case 'error':
      case 'degraded':
        return 'var(--error-color)'
      default:
        return 'var(--text-color-disabled)'
    }
  })

  const usagePercentage = computed(() => {
    if (props.vault.totalGB === 0) return 0
    return Math.round((props.vault.usedGB / props.vault.totalGB) * 100)
  })

  const usageLabel = computed(() => {
    return `${props.vault.usedGB} / ${props.vault.totalGB} GB`
  })

  const usageBarColor = computed(() => {
    const pct = usagePercentage.value
    if (pct >= 90) return '#f43f5e'
    if (pct >= 70) return '#f59e0b'
    return '#3b82f6'
  })

  const snapshotLabel = computed(() => {
    if (!props.vault.lastSnapshotAt) return ''
    const date = new Date(props.vault.lastSnapshotAt)
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  })
</script>

<style scoped>
  .compact-vault-tile {
    height: 84px;
    display: flex;
    align-items: stretch;
    background-color: var(--card-color);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    user-select: none;
    overflow: hidden;
    position: relative;
    cursor: pointer;
    transition:
      border-color 0.2s,
      box-shadow 0.2s,
      background-color 0.2s;
    outline: none;
  }

  .compact-vault-tile:hover {
    border-color: var(--primary-color-hover);
  }

  .compact-vault-tile:focus-visible,
  .compact-vault-tile.is-selected {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 1px var(--primary-color);
  }

  .status-stripe {
    width: 4px;
    flex-shrink: 0;
    transition: background-color 0.2s;
  }

  .tile-content {
    flex: 1 1 auto;
    min-width: 0;
    padding: 8px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .vault-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
    margin-bottom: 2px;
    width: fit-content;
    max-width: 100%;
  }

  .vault-meta-row {
    margin-bottom: 2px;
  }

  .vault-attached {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
    min-width: 0;
  }

  .tile-right-zone {
    flex: 0 0 152px;
    min-width: 0;
    display: grid;
    grid-template-rows: 20px 1fr 24px;
    gap: 2px;
    padding: 6px 6px 4px 6px;
    transition: background-color 0.2s;
    background: linear-gradient(
      to bottom right,
      var(--action-color) 20%,
      color-mix(in srgb, v-bind(statusColor) 10%, var(--action-color)) 100%
    );
  }

  .compact-vault-tile:hover .tile-right-zone {
    background-color: var(--hover-color);
  }

  .zone-row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    min-height: 0;
  }

  .zone-row-middle {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  .zone-row-bottom {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    min-height: 0;
  }

  .snapshot-label {
    font-size: 10px;
    text-align: right;
    line-height: 1;
  }
</style>
