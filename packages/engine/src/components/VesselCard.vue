<template>
  <n-el
    tag="div"
    class="compact-vessel-tile"
    :class="{ 'is-selected': selected }"
    role="button"
    tabindex="0"
    @click="$emit('select')"
    @dblclick="$emit('inspect')"
    @keydown.enter="$emit('select')">
    <div class="status-stripe" :style="{ backgroundColor: statusColor }"></div>
    <div class="tile-content">
      <div class="vessel-name">
        {{ vessel.name }}
      </div>
      <div class="vessel-blueprint">{{ vessel.blueprint }}</div>
      <div v-if="hardwareSummary" class="vessel-hardware">{{ hardwareSummary }}</div>
    </div>
    <div class="tile-right-zone">
      <div class="zone-row-top">
        <n-tooltip :disabled="gpuChipLabel.length < 14">
          <template #trigger>
            <n-tag
              :type="gpuChipType"
              size="small"
              round
              :bordered="false"
              class="gpu-chip"
              :class="{
                'gpu-chip-pulse': isLeaseTransitioning,
                'gpu-chip-dimmed': leaseState.status === 'none' || leaseState.status === 'ineligible',
              }">
              <template #icon><icon :path="mdiExpansionCard" /></template>
              {{ gpuChipLabel }}
            </n-tag>
          </template>
          {{ gpuChipLabel }}
        </n-tooltip>
        <n-text v-if="isLeaseActive" :depth="3" class="gpu-temp" :style="{ color: tempColor }">
          {{ leaseState.status === 'attached' ? `${leaseState.lease.tempCelsius}°C` : '' }}
        </n-text>
      </div>
      <div class="zone-row-middle">
        <div v-if="showVramBar" class="gpu-vram-bar">
          <n-progress type="line" :percentage="vramPercentage" :color="vramBarColor" :height="4" :show-indicator="false" />
          <n-text :depth="3" class="gpu-vram-label">
            {{ vramLabel }}
          </n-text>
        </div>
        <div v-else class="tile-sparkline">
          <micro-sparkline
            v-if="vessel.telemetry?.cpu && vessel.telemetry.cpu.length > 0"
            :data="vessel.telemetry.cpu"
            :color="statusColor"
            :stroke-width="1.5" />
        </div>
      </div>
    </div>
  </n-el>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { NEl, NTooltip, NTag, NText, NProgress } from 'naive-ui'
  import type { WorkspaceVessel, GpuLeaseState } from '../types'
  import MicroSparkline from './MicroSparkline.vue'
  import { Icon } from './Icon'
  import { mdiExpansionCard } from '@mdi/js'

  const props = defineProps<{
    vessel: WorkspaceVessel
    selected?: boolean
  }>()

  defineEmits<{
    (e: 'select'): void
    (e: 'inspect'): void
  }>()

  const statusColor = computed(() => {
    switch (props.vessel.status) {
      case 'online':
        return 'var(--success-color)'
      case 'provisioning':
      case 'starting':
      case 'stopping':
        return 'var(--warning-color)'
      case 'error':
        return 'var(--error-color)'
      default:
        return 'var(--text-color-disabled)'
    }
  })

  const hardwareSummary = computed(() => {
    const parts = []
    if (props.vessel.cpu) parts.push(`${props.vessel.cpu} CPU`)
    if (props.vessel.memory) parts.push(props.vessel.memory)
    return parts.join(' · ')
  })

  const isLeaseActive = computed(() => leaseState.value.status === 'attached')
  const leaseState = computed<GpuLeaseState>(() => {
    return props.vessel.gpuLease ?? { status: 'none' }
  })
  const isLeaseTransitioning = computed(() => {
    return leaseState.value.status === 'requesting' || leaseState.value.status === 'releasing'
  })

  const gpuChipLabel = computed<string>(() => {
    const state = leaseState.value
    switch (state.status) {
      case 'attached':
        return `${state.lease.count}x ${state.lease.gpuType}`
      case 'requesting':
        return 'GPU Attaching…'
      case 'releasing':
        return 'GPU Releasing…'
      case 'none':
        return 'No GPU'
      case 'ineligible':
        return 'Not Supported'
      default:
        return assertNever(state)
    }
  })

  const gpuChipType = computed<'success' | 'warning' | 'default'>(() => {
    const state = leaseState.value
    if (state.status === 'attached') return 'success'
    if (state.status === 'requesting' || state.status === 'releasing') return 'warning'
    return 'default'
  })

  const showVramBar = computed(() => {
    return isLeaseActive.value && props.vessel.status === 'online'
  })

  const vramPercentage = computed(() => {
    const state = leaseState.value
    if (state.status !== 'attached') return 0
    const totalVram = state.lease.vramTotalGB * state.lease.count
    if (totalVram === 0) return 0
    return Math.round((state.lease.vramUsedGB / totalVram) * 100)
  })

  const vramLabel = computed(() => {
    const state = leaseState.value
    if (state.status !== 'attached') return ''
    const totalVram = state.lease.vramTotalGB * state.lease.count
    return `${state.lease.vramUsedGB}/${totalVram}GB`
  })

  const vramBarColor = computed(() => {
    const pct = vramPercentage.value
    if (pct > 90) return '#f43f5e'
    if (pct > 70) return '#f59e0b'
    return '#22c55e'
  })

  const tempColor = computed(() => {
    const state = leaseState.value
    if (state.status !== 'attached') return undefined
    const temp = state.lease.tempCelsius
    if (temp > 80) return '#f43f5e'
    if (temp > 70) return '#f59e0b'
    return undefined
  })

  function assertNever(x: never): never {
    throw new Error(`Unhandled GpuLeaseState variant: ${JSON.stringify(x)}`)
  }
</script>

<style scoped>
  .compact-vessel-tile {
    height: 60px;
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

  .compact-vessel-tile:hover {
    border-color: var(--primary-color-hover);
  }

  .compact-vessel-tile:focus-visible,
  .compact-vessel-tile.is-selected {
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
    padding: 0 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .vessel-name {
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

  .vessel-blueprint {
    font-size: 12px;
    color: var(--text-color-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  }

  .vessel-hardware {
    font-size: 11px;
    color: var(--text-color-3);
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  }

  .tile-right-zone {
    flex: 0 0 162px;
    min-width: 0;
    display: grid;
    grid-template-rows: 24px 1fr;
    gap: 4px;
    padding: 6px 6px 4px 6px;
    transition: background-color 0.2s;
    background: linear-gradient(
      to bottom right,
      var(--action-color) 20%,
      color-mix(in srgb, v-bind(statusColor) 10%, var(--action-color)) 100%
    );
  }

  .compact-vessel-tile:hover .tile-right-zone {
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
    min-height: 0;
    overflow: hidden;
  }

  .gpu-temp {
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .gpu-vram-bar {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .gpu-vram-label {
    font-size: 10px;
    text-align: right;
    line-height: 1;
  }

  .gpu-chip {
    max-width: 138px;
    overflow: hidden;
  }

  :deep(.gpu-chip .n-tag__content) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gpu-chip-pulse {
    animation: gpu-lease-pulse 1.5s ease-in-out infinite;
  }

  .gpu-chip-dimmed {
    opacity: 0.4;
  }

  @keyframes gpu-lease-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .tile-sparkline {
    opacity: 0.8;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    padding: 4px;
    box-sizing: border-box;
  }
</style>
