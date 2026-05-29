<template>
  <n-drawer :show="show" :width="380" placement="right" @update:show="handleUpdateShow">
    <n-drawer-content closable body-content-style="height: 100%; display: flex; flex-direction: column; padding: 0;">
      <template #header>
        <n-flex vertical :size="2" v-if="vessel">
          <n-flex align="center" :size="8">
            <n-text style="font-weight: 600; font-size: 18px; letter-spacing: 0.05em">{{ vessel.name }}</n-text>
            <n-tag :type="statusType" size="small" round :bordered="false">{{ vessel.status.toUpperCase() }}</n-tag>
          </n-flex>
          <n-text depth="3" style="font-size: 12px">{{ resourceSummary }}</n-text>
        </n-flex>
      </template>
      <div v-if="vessel" class="drawer-body">
        <div class="drawer-scroll-area">
          <n-descriptions :column="1" label-placement="left" size="small" :bordered="false" class="vessel-meta">
            <n-descriptions-item label="Blueprint">{{ vessel.blueprint }}</n-descriptions-item>
            <n-descriptions-item label="Uptime">4d 12h 32m</n-descriptions-item>
            <n-descriptions-item label="Internal IP">10.10.10.50</n-descriptions-item>
          </n-descriptions>
          <n-flex justify="space-between" align="center" class="action-bar">
            <n-button-group>
              <n-tooltip trigger="hover" placement="bottom">
                <template #trigger>
                  <n-button
                    size="small"
                    secondary
                    type="success"
                    :disabled="isProcessing || vessel.status === 'online'"
                    :loading="isStarting"
                    @click="handleStart">
                    <template #icon><icon :path="mdiPlay" /></template>
                  </n-button>
                </template>
                Start
              </n-tooltip>
              <n-tooltip trigger="hover" placement="bottom">
                <template #trigger>
                  <n-button
                    size="small"
                    secondary
                    type="warning"
                    :disabled="isProcessing || vessel.status === 'offline'"
                    :loading="isStopping"
                    @click="handleStop">
                    <template #icon><icon :path="mdiStop" /></template>
                  </n-button>
                </template>
                Stop
              </n-tooltip>
              <n-tooltip trigger="hover" placement="bottom">
                <template #trigger>
                  <n-button size="small" secondary :disabled="vessel.status !== 'online'">
                    <template #icon><icon :path="mdiRestart" /></template>
                  </n-button>
                </template>
                Restart
              </n-tooltip>
            </n-button-group>
            <n-flex :size="4" align="center">
              <n-button-group>
                <n-tooltip trigger="hover" placement="bottom">
                  <template #trigger>
                    <n-button size="small" secondary :disabled="vessel.status !== 'online'">
                      <template #icon><icon :path="mdiOpenInNew" /></template>
                    </n-button>
                  </template>
                  Open Application
                </n-tooltip>
                <n-tooltip trigger="hover" placement="bottom">
                  <template #trigger>
                    <n-button size="small" secondary @click="isPinned = !isPinned">
                      <template #icon>
                        <icon :path="isPinned ? mdiPin : mdiPinOff" :style="{ color: isPinned ? '#8b5cf6' : '' }" />
                      </template>
                    </n-button>
                  </template>
                  {{ isPinned ? 'Unpin' : 'Pin' }}
                </n-tooltip>
              </n-button-group>
              <n-popconfirm @positive-click="handleDelete" :positive-button-props="{ type: 'error' }">
                <template #trigger>
                  <n-tooltip trigger="hover" placement="bottom">
                    <template #trigger>
                      <n-button size="small" secondary type="error" :disabled="isProcessing || isDeleting">
                        <template #icon><icon :path="mdiDelete" /></template>
                      </n-button>
                    </template>
                    Delete
                  </n-tooltip>
                </template>
                Permanently delete this vessel and its data?
              </n-popconfirm>
            </n-flex>
          </n-flex>
          <n-divider style="margin: 16px 0 8px 0" />
          <n-collapse v-model:expanded-names="expandedNames">
            <!-- Hardware Panel — reworked for GPU lease lifecycle -->
            <n-collapse-item title="Hardware" name="hardware">
              <!-- Path A: Attached + Online — full telemetry -->
              <template v-if="isLeaseActive && vessel.status === 'online' && leaseState.status === 'attached'">
                <n-flex align="center" :size="24">
                  <n-progress
                    type="dashboard"
                    gap-position="bottom"
                    :percentage="leaseState.lease.utilization"
                    :color="utilizationRingColor"
                    :stroke-width="8"
                    style="width: 80px">
                    <div style="text-align: center">
                      <span style="font-size: 20px; font-weight: bold">{{ leaseState.lease.utilization }}%</span>
                      <br />
                      <span style="font-size: 10px; opacity: 0.6">Utilization</span>
                    </div>
                  </n-progress>
                  <n-flex vertical :size="8" style="flex: 1">
                    <n-flex justify="space-between">
                      <n-text depth="3" style="font-size: 12px">
                        <icon :path="mdiExpansionCard" :size="14" style="vertical-align: -2px; margin-right: 4px" />
                        Type
                      </n-text>
                      <n-text style="font-size: 12px; font-weight: 600">{{ leaseState.lease.count }}x {{ leaseState.lease.gpuType }}</n-text>
                    </n-flex>
                    <n-flex justify="space-between">
                      <n-text depth="3" style="font-size: 12px">
                        <icon :path="mdiMemory" :size="14" style="vertical-align: -2px; margin-right: 4px" />
                        VRAM
                      </n-text>
                      <n-text style="font-size: 12px; font-weight: 600">{{ leaseState.lease.vramUsedGB }}GB / {{ totalVram }}GB</n-text>
                    </n-flex>
                    <n-flex justify="space-between">
                      <n-text depth="3" style="font-size: 12px">
                        <icon :path="mdiThermometer" :size="14" style="vertical-align: -2px; margin-right: 4px" />
                        Temp
                      </n-text>
                      <n-text style="font-size: 12px; font-weight: 600" :style="{ color: drawerTempColor }">
                        {{ leaseState.lease.tempCelsius }}°C
                      </n-text>
                    </n-flex>
                  </n-flex>
                </n-flex>
                <n-text depth="3" style="font-size: 12px; margin-top: 12px; display: block">Leased for: {{ leaseDuration }}</n-text>
                <n-popconfirm @positive-click="handleReleaseLease" :positive-button-props="{ type: 'warning' }">
                  <template #trigger>
                    <n-button size="small" secondary type="warning" style="margin-top: 12px" :disabled="isLeaseTransitioning">
                      <template #icon><icon :path="mdiFlash" /></template>
                      Release Lease
                    </n-button>
                  </template>
                  Release this GPU lease? The vessel will lose GPU access.
                </n-popconfirm>
              </template>
              <!-- Path B: Attached + Offline — lease held, no telemetry -->
              <template v-else-if="isLeaseActive && vessel.status !== 'online' && leaseState.status === 'attached'">
                <n-flex vertical :size="12">
                  <n-flex align="center" :size="8">
                    <icon :path="mdiFlash" :size="16" style="color: #f59e0b" />
                    <n-text style="font-weight: 600; font-size: 13px">
                      {{ leaseState.lease.count }}x {{ leaseState.lease.gpuType }} — Lease Held (Idle)
                    </n-text>
                  </n-flex>
                  <n-text depth="3" style="font-size: 13px; font-style: italic">
                    GPU is attached but vessel is offline. Telemetry available when online.
                  </n-text>
                  <n-text depth="3" style="font-size: 12px">Leased for: {{ leaseDuration }}</n-text>
                  <n-popconfirm @positive-click="handleReleaseLease" :positive-button-props="{ type: 'warning' }">
                    <template #trigger>
                      <n-button size="small" secondary type="warning" :disabled="isLeaseTransitioning" style="align-self: flex-start">
                        <template #icon><icon :path="mdiFlash" /></template>
                        Release Lease
                      </n-button>
                    </template>
                    Release this GPU lease? The vessel will lose GPU access.
                  </n-popconfirm>
                </n-flex>
              </template>
              <!-- Path C: No lease — pool availability + request flow -->
              <template v-else-if="leaseState.status === 'none'">
                <n-flex vertical :size="12">
                  <n-text depth="3" style="font-size: 13px; font-style: italic">No GPU lease attached.</n-text>
                  <div v-for="pool in mockPoolAvailability" :key="pool.gpuType" class="pool-availability-card">
                    <n-flex vertical :size="8">
                      <n-flex justify="space-between" align="center">
                        <n-text style="font-weight: 600; font-size: 13px">
                          <icon :path="mdiExpansionCard" :size="14" style="vertical-align: -2px; margin-right: 4px" />
                          {{ pool.gpuType }} ({{ pool.vramGB }}GB)
                        </n-text>
                        <n-text
                          :depth="pool.availableCount > 0 ? 3 : 2"
                          :style="{ fontSize: '12px', color: pool.availableCount === 0 ? '#f43f5e' : undefined }">
                          {{ pool.availableCount }} of {{ pool.totalCount }} available
                        </n-text>
                      </n-flex>
                      <n-flex :size="8">
                        <n-button
                          v-for="count in availableRequestCounts(pool)"
                          :key="count"
                          size="small"
                          secondary
                          type="primary"
                          :disabled="count > pool.availableCount"
                          @click="handleRequestLease(pool.gpuType, count)">
                          Request {{ count }}x
                        </n-button>
                      </n-flex>
                    </n-flex>
                  </div>
                </n-flex>
              </template>
              <!-- Path D: Requesting — GPU hot-plug in flight -->
              <template v-else-if="leaseState.status === 'requesting'">
                <n-flex align="center" :size="12">
                  <n-spin size="small" />
                  <n-flex vertical :size="2">
                    <n-text style="font-weight: 600; font-size: 13px">
                      <icon :path="mdiFlash" :size="14" style="vertical-align: -2px; margin-right: 4px" />
                      Attaching GPU…
                    </n-text>
                    <n-text depth="3" style="font-size: 12px">Hot-plugging GPU device into vessel. This may take a few seconds.</n-text>
                  </n-flex>
                </n-flex>
              </template>
              <!-- Path E: Releasing — GPU detach in flight -->
              <template v-else-if="leaseState.status === 'releasing'">
                <n-flex align="center" :size="12">
                  <n-spin size="small" />
                  <n-flex vertical :size="2">
                    <n-text style="font-weight: 600; font-size: 13px">
                      <icon :path="mdiFlash" :size="14" style="vertical-align: -2px; margin-right: 4px" />
                      Releasing GPU…
                    </n-text>
                    <n-text depth="3" style="font-size: 12px">Detaching GPU device from vessel. This may take a few seconds.</n-text>
                  </n-flex>
                </n-flex>
              </template>
              <!-- Path F: Ineligible — blueprint doesn't support GPU -->
              <template v-else-if="leaseState.status === 'ineligible'">
                <n-text depth="3" style="font-size: 13px; font-style: italic">This blueprint does not support GPU acceleration.</n-text>
              </template>
            </n-collapse-item>
            <!-- Storage Panel -->
            <n-collapse-item title="Storage" name="storage">
              <n-flex vertical :size="12">
                <div class="vault-item">
                  <n-flex justify="space-between" align="center">
                    <n-text style="font-weight: 600; font-size: 13px">
                      <icon :path="mdiFolder" :size="14" style="vertical-align: -2px; margin-right: 4px" />
                      {{ vessel.name }}-world
                    </n-text>
                    <n-text depth="3" style="font-size: 12px">4.2GB / 10GB</n-text>
                  </n-flex>
                  <n-progress type="line" :percentage="42" color="#3b82f6" :height="6" :show-indicator="false" style="margin: 8px 0" />
                  <n-flex :size="8">
                    <n-button size="tiny" secondary disabled>Browse Files</n-button>
                    <n-button size="tiny" secondary disabled>
                      <template #icon><icon :path="mdiCameraIris" :size="14" /></template>
                      Snapshot
                    </n-button>
                  </n-flex>
                </div>
              </n-flex>
            </n-collapse-item>
            <!-- Network Panel -->
            <n-collapse-item title="Network" name="network">
              <n-flex vertical :size="12">
                <n-flex v-for="port in vessel.ports" :key="port.name" justify="space-between" align="center">
                  <n-flex align="center" :size="8">
                    <n-tag size="small" :bordered="false" :type="port.protocol === 'tcp' ? 'info' : 'warning'">
                      {{ port.protocol.toUpperCase() }}
                    </n-tag>
                    <n-text style="font-size: 13px">{{ port.name }}</n-text>
                  </n-flex>
                  <n-text code style="font-size: 12px">{{ vessel.name }}.ionsignal.com:{{ port.port }}</n-text>
                </n-flex>
              </n-flex>
            </n-collapse-item>
            <!-- Configuration Panel -->
            <n-collapse-item title="Configuration" name="configuration">
              <n-flex vertical :size="8">
                <n-text depth="3" style="font-size: 12px">Blueprint: {{ vessel.blueprint }}</n-text>
                <n-text depth="3" style="font-size: 12px">Created: 2024-05-12 14:32:00</n-text>
                <n-text depth="3" style="font-size: 12px">Last State Change: 2024-05-16 09:15:22</n-text>
              </n-flex>
            </n-collapse-item>
            <!-- Topology Panel -->
            <n-collapse-item title="Topology" name="topology">
              <div style="height: 180px; border-radius: 6px; overflow: hidden; background: rgb(16, 16, 20)">
                <vessel-topology
                  v-if="isMounted && expandedNames.includes('topology')"
                  :vessel="vessel"
                  :interactive="true"
                  flow-id="drawer-topology" />
              </div>
            </n-collapse-item>
          </n-collapse>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
  import { ref, computed, onMounted, onUnmounted } from 'vue'
  import {
    NDrawer,
    NDrawerContent,
    NFlex,
    NText,
    NTag,
    NButton,
    NButtonGroup,
    NPopconfirm,
    NCollapse,
    NCollapseItem,
    NProgress,
    NDescriptions,
    NDescriptionsItem,
    NDivider,
    NTooltip,
    NSpin,
    useMessage,
  } from 'naive-ui'
  import { Icon } from './Icon'
  import VesselTopology from './VesselTopology.vue'
  import {
    mdiPlay,
    mdiStop,
    mdiRestart,
    mdiOpenInNew,
    mdiPin,
    mdiPinOff,
    mdiDelete,
    mdiMemory,
    mdiThermometer,
    mdiFolder,
    mdiCameraIris,
    mdiExpansionCard,
    mdiFlash,
  } from '@mdi/js'
  import { isTRPCClientError } from '@trpc/client'
  import { useInstanceContext } from '../composables/useInstances'
  import type { WorkspaceVessel, GpuLeaseState, GpuPoolAvailability } from '../types'

  const props = defineProps<{
    show: boolean
    vessel: WorkspaceVessel | null
    mock?: boolean
  }>()

  const emit = defineEmits<{
    (e: 'update:show', value: boolean): void
    (e: 'request-lease', payload: { vesselId: string; gpuType: string; count: number }): void
    (e: 'release-lease', vesselId: string): void
  }>()

  const message = useMessage()
  const isPinned = ref(false)
  const isStarting = ref(false)
  const isStopping = ref(false)
  const isDeleting = ref(false)
  const isMounted = ref(false)
  const expandedNames = ref<string[]>(['hardware', 'topology'])

  // Mock GPU pool availability — will be replaced by backend pool query
  const mockPoolAvailability: GpuPoolAvailability[] = [{ gpuType: 'RTX A4000', vramGB: 16, totalCount: 4, availableCount: 2 }]

  // Lease duration timer state
  const leaseDuration = ref('')
  let durationInterval: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    isMounted.value = true
    durationInterval = setInterval(updateLeaseDuration, 60_000)
    updateLeaseDuration()
  })

  onUnmounted(() => {
    if (durationInterval) clearInterval(durationInterval)
  })

  function updateLeaseDuration() {
    const state = leaseState.value
    if (state.status !== 'attached') {
      leaseDuration.value = ''
      return
    }
    const elapsed = Date.now() - new Date(state.lease.leasedSince).getTime()
    const days = Math.floor(elapsed / 86_400_000)
    const hours = Math.floor((elapsed % 86_400_000) / 3_600_000)
    const minutes = Math.floor((elapsed % 3_600_000) / 60_000)
    const parts: string[] = []
    if (days > 0) parts.push(`${days}d`)
    if (hours > 0) parts.push(`${hours}h`)
    parts.push(`${minutes}m`)
    leaseDuration.value = parts.join(' ')
  }

  const isProcessing = computed(() => {
    return (
      isStarting.value || isStopping.value || isDeleting.value || ['provisioning', 'starting', 'stopping'].includes(props.vessel?.status || '')
    )
  })

  const statusType = computed(() => {
    switch (props.vessel?.status) {
      case 'online':
        return 'success'
      case 'provisioning':
      case 'starting':
      case 'stopping':
        return 'warning'
      case 'error':
        return 'error'
      default:
        return 'default'
    }
  })

  const resourceSummary = computed(() => {
    if (!props.vessel) return ''
    const parts: string[] = [props.vessel.blueprint]
    if (props.vessel.cpu) parts.push(`${props.vessel.cpu} CPU`)
    if (props.vessel.memory) parts.push(props.vessel.memory)
    const state = leaseState.value
    if (state.status === 'attached') {
      parts.push(`${state.lease.count}x ${state.lease.gpuType}`)
    } else if (props.vessel.gpu) {
      parts.push(props.vessel.gpu)
    }
    return parts.join(' · ')
  })

  const leaseState = computed<GpuLeaseState>(() => {
    return props.vessel?.gpuLease ?? { status: 'none' }
  })

  const isLeaseActive = computed(() => leaseState.value.status === 'attached')

  const isLeaseTransitioning = computed(() => {
    return leaseState.value.status === 'requesting' || leaseState.value.status === 'releasing'
  })

  const totalVram = computed(() => {
    const state = leaseState.value
    if (state.status !== 'attached') return 0
    return state.lease.vramTotalGB * state.lease.count
  })

  const utilizationRingColor = computed(() => {
    const state = leaseState.value
    if (state.status !== 'attached') return '#22c55e'
    const util = state.lease.utilization
    if (util > 90) return '#f43f5e'
    if (util > 70) return '#f59e0b'
    return '#22c55e'
  })

  const drawerTempColor = computed(() => {
    const state = leaseState.value
    if (state.status !== 'attached') return undefined
    const temp = state.lease.tempCelsius
    if (temp > 80) return '#f43f5e'
    if (temp > 70) return '#f59e0b'
    return undefined
  })

  function availableRequestCounts(pool: GpuPoolAvailability): number[] {
    return [1, 2, 4].filter(n => n <= pool.totalCount)
  }

  function handleUpdateShow(val: boolean) {
    emit('update:show', val)
  }

  function handleRequestLease(gpuType: string, count: number) {
    if (!props.vessel) return
    emit('request-lease', { vesselId: props.vessel.id, gpuType, count })
  }

  function handleReleaseLease() {
    if (!props.vessel) return
    emit('release-lease', props.vessel.id)
  }

  const instanceCtx = props.mock ? null : useInstanceContext()

  async function handleStart() {
    if (!props.vessel) return
    isStarting.value = true
    try {
      if (instanceCtx) {
        await instanceCtx.start(props.vessel.name)
      } else {
        await new Promise(r => setTimeout(r, 1000))
      }
      message.success('Instance starting...')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to start instance')
    } finally {
      isStarting.value = false
    }
  }

  async function handleStop() {
    if (!props.vessel) return
    isStopping.value = true
    try {
      if (instanceCtx) {
        await instanceCtx.stop(props.vessel.name)
      } else {
        await new Promise(r => setTimeout(r, 1000))
      }
      message.success('Instance stopping...')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to stop instance')
    } finally {
      isStopping.value = false
    }
  }

  async function handleDelete() {
    if (!props.vessel) return
    isDeleting.value = true
    try {
      if (instanceCtx) {
        await instanceCtx.delete(props.vessel.name)
      } else {
        await new Promise(r => setTimeout(r, 1000))
      }
      message.success('Instance deleted')
      emit('update:show', false)
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to delete instance')
    } finally {
      isDeleting.value = false
    }
  }
</script>

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

  .vault-item {
    padding: 12px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
  }

  .pool-availability-card {
    padding: 12px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.03);
  }
</style>
