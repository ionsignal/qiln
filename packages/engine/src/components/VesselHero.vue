<template>
  <div class="vessel-hero-container" :style="heroStyle">
    <!-- Identity & Actions (Unchanged) -->
    <div class="hero-header">
      <div class="hero-identity">
        <div class="identity-row-primary">
          <div class="status-dot" :style="{ backgroundColor: statusColor, boxShadow: `0 0 8px ${statusColor}` }"></div>
          <span class="vessel-name">{{ vessel.name }}</span>
        </div>
        <div class="identity-row-secondary">
          <span class="vessel-blueprint">{{ vessel.blueprint }}</span>
        </div>
        <div class="identity-row-tertiary">
          <span class="vessel-meta code">{{ primaryEndpoint }}</span>
          <span class="meta-separator">&bull;</span>
          <span class="vessel-meta">{{ uptimeDisplay }}</span>
        </div>
      </div>
      <div class="hero-actions">
        <n-flex align="center" :size="8">
          <n-button-group>
            <n-button
              v-if="vessel.status === 'online' || vessel.status === 'starting' || vessel.status === 'stopping'"
              secondary
              type="error"
              size="small"
              :disabled="isProcessing"
              :loading="vessel.status === 'stopping'"
              @click="$emit('stop')">
              <template #icon><icon :path="mdiStop" :size="16" /></template>
              Stop
            </n-button>
            <n-button
              v-if="vessel.status === 'offline' || vessel.status === 'stopping' || vessel.status === 'starting'"
              secondary
              type="success"
              size="small"
              :disabled="isProcessing"
              :loading="vessel.status === 'starting'"
              @click="$emit('start')">
              <template #icon><icon :path="mdiPlay" :size="16" /></template>
              Start
            </n-button>
            <n-button v-if="vessel.status === 'online'" secondary size="small" :disabled="isProcessing" @click="$emit('restart')">
              <template #icon><icon :path="mdiRestart" :size="16" /></template>
              Restart
            </n-button>
            <n-dropdown placement="bottom-end" :options="moreOptions" @select="handleMoreSelect">
              <n-button secondary size="small" :disabled="isProcessing">
                <template #icon><icon :path="mdiDotsVertical" :size="16" /></template>
              </n-button>
            </n-dropdown>
          </n-button-group>
          <n-button color="white" type="primary" size="small" :disabled="vessel.status !== 'online'" @click="$emit('open')">
            Open App
            <template #icon><icon :path="mdiOpenInNew" :size="16" /></template>
          </n-button>
        </n-flex>
      </div>
    </div>
    <!-- Bottom Section: The Recessed Telemetry Matrix -->
    <div class="telemetry-matrix">
      <!-- Offline State -->
      <div v-if="vessel.status === 'offline'" class="offline-state">
        <n-flex vertical align="center" :size="12">
          <icon :path="mdiPowerPlugOff" :size="32" style="opacity: 0.3" />
          <n-text depth="3" style="font-size: 13px">Telemetry offline. Vessel is powered down.</n-text>
          <n-button type="primary" size="small" @click="$emit('start')">
            <template #icon><icon :path="mdiPlay" :size="16" /></template>
            Wake Vessel
          </n-button>
        </n-flex>
      </div>
      <!-- Processing State -->
      <div v-else-if="isProcessing && vessel.status !== 'online'" class="offline-state">
        <n-flex vertical align="center" :size="12">
          <n-spin size="medium" />
          <n-text depth="3" style="font-size: 13px">
            {{ vessel.status === 'starting' ? 'Booting vessel and attaching devices...' : 'Shutting down...' }}
          </n-text>
        </n-flex>
      </div>
      <!-- Online / Telemetry State -->
      <div v-else class="metrics-grid">
        <!-- CPU Column -->
        <div class="metric-col">
          <div class="metric-header">
            <span class="metric-label">CPU Usage</span>
            <span class="metric-limit">{{ vessel.cpu || 4 }} Cores</span>
          </div>
          <div class="metric-value">
            <n-number-animation v-if="isMounted" :from="0" :to="currentCpu" :precision="1" />
            <span v-else>{{ currentCpu.toFixed(1) }}</span>
            <span class="metric-unit">%</span>
          </div>
          <div class="metric-secondary">
            <span>Load: {{ cpuLoad.toFixed(2) }}</span>
          </div>
          <div class="telemetry-trough">
            <div class="metric-sparkline">
              <micro-sparkline
                :data="cpuSparkline"
                color="rgba(255,255,255,0.4)"
                :stroke-width="2"
                :min="0"
                :max="100"
                show-grid
                show-labels
                :value-formatter="formatPercent" />
              <div class="metric-rail">
                <n-progress type="line" :percentage="currentCpu" :color="cpuBarColor" :height="2" :show-indicator="false" />
              </div>
            </div>
          </div>
        </div>
        <!-- RAM Column -->
        <div class="metric-col">
          <div class="metric-header">
            <span class="metric-label">System RAM</span>
            <span class="metric-limit">{{ vessel.memory || '4GB' }}</span>
          </div>
          <div class="metric-value">
            <n-number-animation v-if="isMounted" :from="0" :to="currentRam" :precision="1" />
            <span v-else>{{ currentRam.toFixed(1) }}</span>
            <span class="metric-unit">GB</span>
          </div>
          <div class="metric-secondary">
            <span>{{ ramFree.toFixed(1) }} GB free</span>
          </div>
          <div class="telemetry-trough">
            <div class="metric-sparkline">
              <micro-sparkline
                :data="ramSparkline"
                color="rgba(255,255,255,0.4)"
                :stroke-width="2"
                :min="0"
                :max="totalRamGB"
                show-grid
                show-labels
                :value-formatter="formatGB" />
              <div class="metric-rail">
                <n-progress type="line" :percentage="ramPercentage" :color="ramBarColor" :height="2" :show-indicator="false" />
              </div>
            </div>
          </div>
        </div>
        <!-- GPU Column (Conditional) -->
        <div class="metric-col">
          <div class="metric-header">
            <span class="metric-label">GPU</span>
            <span class="metric-limit" v-if="activeGpuLease">{{ activeGpuLease.count }}x {{ activeGpuLease.gpuType }}</span>
            <span class="metric-limit" v-else>No GPU</span>
          </div>
          <template v-if="activeGpuLease">
            <div class="metric-value">
              <n-number-animation v-if="isMounted" :from="0" :to="activeGpuLease.utilization" :precision="0" />
              <span v-else>{{ activeGpuLease.utilization }}</span>
              <span class="metric-unit">%</span>
            </div>
            <div class="metric-secondary">
              <n-flex align="center" :size="4">
                <icon :path="mdiDatabaseOutline" :size="12" />
                <span>{{ activeGpuLease.vramUsedGB.toFixed(1) }} GB</span>
              </n-flex>
              <span style="opacity: 0.3; margin: 0 4px">|</span>
              <n-flex align="center" :size="2" :style="{ color: gpuTempColor }">
                <icon :path="mdiThermometer" :size="12" />
                <span>{{ activeGpuLease.tempCelsius }}°C</span>
              </n-flex>
            </div>
            <div class="telemetry-trough">
              <div class="metric-sparkline">
                <micro-sparkline
                  :data="gpuSparkline"
                  color="rgba(255,255,255,0.4)"
                  :stroke-width="2"
                  :min="0"
                  :max="100"
                  show-grid
                  show-labels
                  :value-formatter="formatPercent" />
                <div class="metric-rail">
                  <n-progress type="line" :percentage="vramPercentage" :color="gpuBarColor" :height="2" :show-indicator="false" />
                </div>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="metric-empty">
              <n-text depth="3" style="font-size: 11px; font-style: italic">Not attached</n-text>
            </div>
          </template>
        </div>
        <!-- Network Column -->
        <div class="metric-col">
          <div class="metric-header">
            <span class="metric-label">Network I/O</span>
            <span class="metric-limit">eth0</span>
          </div>
          <div class="metric-value">
            <n-number-animation v-if="isMounted" :from="0" :to="currentNet" :precision="1" />
            <span v-else>{{ currentNet.toFixed(1) }}</span>
            <span class="metric-unit">Mbps</span>
          </div>
          <div class="metric-secondary">
            <n-flex align="center" :size="2">
              <icon :path="mdiArrowDown" :size="12" />
              <span>{{ netDown.toFixed(1) }}</span>
            </n-flex>
            <span style="opacity: 0.3; margin: 0 4px">|</span>
            <n-flex align="center" :size="2">
              <icon :path="mdiArrowUp" :size="12" />
              <span>{{ netUp.toFixed(1) }}</span>
            </n-flex>
          </div>
          <div class="telemetry-trough">
            <div class="metric-sparkline">
              <micro-sparkline
                :data="netSparkline"
                color="rgba(255,255,255,0.4)"
                :stroke-width="2"
                show-grid
                show-labels
                :value-formatter="formatMbps" />
              <div class="metric-rail">
                <n-progress type="line" :percentage="netPercentage" :color="netBarColor" :height="2" :show-indicator="false" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { ref, computed, onMounted, onUnmounted, h } from 'vue'
  import { NFlex, NButton, NButtonGroup, NDropdown, NText, NProgress, NNumberAnimation, NSpin } from 'naive-ui'
  import { Icon } from './Icon'
  import {
    mdiPlay,
    mdiStop,
    mdiRestart,
    mdiOpenInNew,
    mdiDotsVertical,
    mdiPowerPlugOff,
    mdiMagnify,
    mdiDelete,
    mdiFlash,
    mdiThermometer,
    mdiArrowDown,
    mdiArrowUp,
    mdiDatabaseOutline,
  } from '@mdi/js'
  import { resolveTelemetryToken, getTelemetryVar } from '../composables/useTelemetryThreshold'
  import type { DropdownOption } from 'naive-ui'
  import type { WorkspaceVessel } from '../types'

  import MicroSparkline from './MicroSparkline.vue'

  const props = defineProps<{
    vessel: WorkspaceVessel
  }>()

  const emit = defineEmits<{
    (e: 'start'): void
    (e: 'stop'): void
    (e: 'restart'): void
    (e: 'inspect'): void
    (e: 'open'): void
    (e: 'request-lease'): void
    (e: 'release-lease'): void
    (e: 'delete'): void
  }>()

  const formatPercent = (v: number) => v.toFixed(0) + '%'
  const formatGB = (v: number) => v.toFixed(1) + 'GB'
  const formatMbps = (v: number) => v.toFixed(1) + 'M'

  const isMounted = ref(false)
  const activeUptime = ref('Calculating...')
  let uptimeInterval: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    isMounted.value = true
    uptimeInterval = setInterval(() => {
      activeUptime.value = '4d 12h 32m'
    }, 60000)
    activeUptime.value = '4d 12h 32m'
  })

  onUnmounted(() => {
    if (uptimeInterval) clearInterval(uptimeInterval)
  })

  const uptimeDisplay = computed(() => {
    if (!isMounted.value) return '--'
    return activeUptime.value
  })

  const isProcessing = computed(() => {
    return ['provisioning', 'starting', 'stopping'].includes(props.vessel.status)
  })

  const statusColor = computed(() => {
    switch (props.vessel.status) {
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
  })

  const heroStyle = computed(() => {
    const glowColor =
      props.vessel.status === 'online'
        ? 'rgba(34, 197, 94, 0.08)'
        : props.vessel.status === 'error'
          ? 'rgba(244, 63, 94, 0.08)'
          : props.vessel.status === 'offline'
            ? 'rgba(255, 255, 255, 0.03)'
            : 'rgba(245, 158, 11, 0.08)'
    return {
      backgroundImage: `radial-gradient(circle at top left, ${glowColor} 0%, transparent 50%)`,
    }
  })

  const primaryEndpoint = computed(() => {
    if (props.vessel.ports && props.vessel.ports.length > 0) {
      const p = props.vessel.ports[0]
      return `${props.vessel.name}.ionsignal.com:${p.port}`
    }
    return 'No exposed ports'
  })

  const activeGpuLease = computed(() => {
    if (props.vessel.gpuLease?.status === 'attached') {
      return props.vessel.gpuLease.lease
    }
    return null
  })

  const renderIcon = (path: string, color?: string) => () => h(Icon, { path, size: 16, style: color ? { color } : {} })

  const moreOptions = computed<DropdownOption[]>(() => {
    const options: DropdownOption[] = [{ label: 'Inspect Details', key: 'inspect', icon: renderIcon(mdiMagnify) }]
    if (props.vessel.gpuLease?.status === 'none' && props.vessel.status === 'offline') {
      options.push({ label: 'Request GPU Lease', key: 'request-lease', icon: renderIcon(mdiFlash, '#3b82f6') })
    }
    if (props.vessel.gpuLease?.status === 'attached') {
      options.push({ label: 'Release GPU Lease', key: 'release-lease', icon: renderIcon(mdiFlash, '#f59e0b') })
    }
    options.push({ type: 'divider', key: 'd1' })
    options.push({ label: 'Delete Vessel', key: 'delete', icon: renderIcon(mdiDelete, '#f43f5e') })
    return options
  })

  function handleMoreSelect(key: string) {
    emit(key as any)
  }

  const fallbackArray = [0, 0, 0, 0, 0]
  const netBarColor = computed(() => 'rgba(255, 255, 255, 0.4)')
  const gpuSparkline = computed(() => props.vessel.telemetry?.gpu ?? fallbackArray)
  const cpuSparkline = computed(() => props.vessel.telemetry?.cpu ?? fallbackArray)
  const currentCpu = computed(() => cpuSparkline.value[cpuSparkline.value.length - 1] ?? 0)
  const cpuLoad = computed(() => (currentCpu.value / 100) * (props.vessel.cpu || 4))
  const ramSparkline = computed(() => props.vessel.telemetry?.memory ?? fallbackArray)
  const totalRamGB = computed(() => parseFloat(props.vessel.memory || '4') || 4)
  const currentRam = computed(() => ramSparkline.value[ramSparkline.value.length - 1] ?? 0)
  const ramPercentage = computed(() => (totalRamGB.value > 0 ? (currentRam.value / totalRamGB.value) * 100 : 0))
  const ramFree = computed(() => Math.max(0, totalRamGB.value - currentRam.value))
  const netSparkline = computed(() => props.vessel.telemetry?.network ?? fallbackArray)
  const currentNet = computed(() => netSparkline.value[netSparkline.value.length - 1] ?? 0)
  const netDown = computed(() => currentNet.value * 0.8) // Mock 80% inbound
  const netUp = computed(() => currentNet.value * 0.2) // Mock 20% outbound
  const netPercentage = computed(() => {
    const val = Math.max(0, currentNet.value)
    const pct = (Math.log10(val + 1) / 3) * 100 // log10(1000) = 3
    return Math.min(Math.max(pct, 0), 100) || 0
  })

  const vramPercentage = computed(() => {
    if (!activeGpuLease.value) return 0
    const total = activeGpuLease.value.vramTotalGB * activeGpuLease.value.count
    return total > 0 ? Math.round((activeGpuLease.value.vramUsedGB / total) * 100) : 0
  })

  const cpuBarColor = computed(() => {
    return getTelemetryVar(resolveTelemetryToken(currentCpu.value, { elevated: 70, critical: 90 }))
  })

  const ramBarColor = computed(() => {
    return getTelemetryVar(resolveTelemetryToken(ramPercentage.value, { elevated: 80, critical: 95 }, 'cool'))
  })

  const gpuTempColor = computed(() => {
    if (!activeGpuLease.value) return 'inherit'
    const token = resolveTelemetryToken(activeGpuLease.value.tempCelsius, { elevated: 70, critical: 80 })
    return token === 'healthy' ? 'inherit' : getTelemetryVar(token)
  })

  const gpuBarColor = computed(() => {
    if (!activeGpuLease.value) return getTelemetryVar('healthy')
    return getTelemetryVar(resolveTelemetryToken(activeGpuLease.value.utilization, { elevated: 70, critical: 90 }))
  })
</script>

<style scoped>
  .vessel-hero-container {
    background-color: var(--card-color);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: background-image 0.5s ease;
  }

  .hero-header {
    padding: 18px 0 18px 24px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
  }

  .hero-identity {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .identity-row-primary {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .vessel-name {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.95);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  }

  .identity-row-secondary,
  .identity-row-tertiary {
    display: grid;
    grid-template-columns: 10px 1fr;
    gap: 12px;
  }

  .identity-row-secondary > span,
  .identity-row-tertiary > span {
    grid-column: 2;
  }

  .identity-row-tertiary {
    display: flex;
    padding-left: 22px;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }

  .vessel-blueprint {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    font-weight: 500;
  }

  .vessel-meta {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
  }

  .vessel-meta.code {
    font-family: 'Fira Code', 'Cascadia Code', monospace;
  }

  .meta-separator {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.2);
    user-select: none;
  }

  .hero-actions {
    flex-shrink: 0;
    padding-top: 4px;
  }

  .telemetry-matrix {
    background-color: rgba(0, 0, 0, 0.15);
    box-shadow:
      inset 0 1px 0 var(--qiln-surface-highlight),
      inset 0 2px 6px rgba(0, 0, 0, 0.2);
    border-top: 1px solid var(--qiln-surface-border-strong);
    min-height: 120px;
    display: flex;
    flex-direction: column;
  }

  .offline-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    flex: 1;
  }

  .metric-col {
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-right: 1px solid var(--qiln-surface-border-strong);
  }

  .metric-col:last-child {
    border-right: none;
  }

  .metric-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .metric-label {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    font-weight: 600;
  }

  .metric-limit {
    font-size: 10px;
    font-weight: 400;
    color: rgba(255, 255, 255, 0.3);
  }

  .metric-value {
    font-size: 20px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    line-height: 1.1;
    display: flex;
    align-items: baseline;
    font-variant-numeric: tabular-nums;
    font-family: 'Roboto', monospace;
  }

  .metric-unit {
    font-size: 12px;
    font-weight: 400;
    opacity: 0.5;
    margin-left: 4px;
  }

  .metric-secondary {
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    color: rgba(255, 255, 255, 0.5);
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: 'Fira Code', 'Cascadia Code', monospace;
    font-variant-numeric: tabular-nums;
  }

  .telemetry-trough {
    flex: 1;
    display: flex;
    flex-direction: column;
    /* background-color: rgba(0, 0, 0, 0.04); */
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.24);
    border-radius: 6px;
    padding: 10px 10px 12px 10px;
    gap: 6px;
    margin-top: 4px;
    position: relative;
    overflow: hidden;
  }

  .metric-sparkline {
    flex: 1;
    min-height: 30px;
    opacity: 0.85;
  }

  .metric-rail {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    display: block;
  }

  .metric-rail :deep(.n-progress-graph-line-rail) {
    background-color: rgba(0, 0, 0, 0.88) !important;
  }

  .metric-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-top: 8px;
  }
</style>
