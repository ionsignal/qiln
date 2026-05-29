<template>
  <div class="workspace-wrapper">
    <div class="workspace-scroll-area">
      <n-flex vertical :size="24">
        <template v-if="mockVessels.length === 0">
          <n-flex justify="space-between" align="center">
            <div>
              <h1 style="margin: 0; font-size: 24px; font-weight: 600">Compute Vessels</h1>
              <n-text depth="3">Your provisioned system and application instances.</n-text>
            </div>
            <n-button type="primary" size="small" color="white" strong>Cast New Vessel</n-button>
          </n-flex>
          <n-empty description="No vessels provisioned." />
        </template>
        <template v-else>
          <!-- Hero (Focused Vessel) -->
          <vessel-hero
            v-if="selectedVessel"
            :vessel="selectedVessel"
            @start="handleStartVessel(selectedVessel.id)"
            @stop="handleStopVessel(selectedVessel.id)"
            @restart="handleRestartVessel(selectedVessel.id)"
            @inspect="handleInspectVessel(selectedVessel.id)"
            @open="handleOpenApp(selectedVessel.id)"
            @request-lease="handleRequestLease({ vesselId: selectedVessel.id, gpuType: 'RTX A4000', count: 1 })"
            @release-lease="handleReleaseLease(selectedVessel.id)"
            @delete="handleDeleteVessel(selectedVessel.id)" />
          <n-divider style="margin: 0" />
          <!-- Section Header (Fleet Overview) -->
          <n-flex justify="space-between" align="center">
            <div>
              <n-flex align="baseline" :size="12">
                <h1 style="margin: 0; font-size: 24px; font-weight: 600">Compute Vessels</h1>
                <!-- Fleet Aggregates -->
                <n-text depth="3" style="font-size: 13px; font-weight: 500">({{ onlineCount }} online · {{ offlineCount }} offline)</n-text>
              </n-flex>
              <n-text depth="3">Your provisioned system and application instances.</n-text>
            </div>
            <n-button type="primary" size="small" color="white" ghost>
              Cast New Vessel
              <!-- <template #icon><icon :path="mdiPlusBox" /></template> -->
            </n-button>
          </n-flex>
          <!-- Fleet Grid -->
          <div class="fleet-grid" :class="{ 'grid-dimmed': showDrawer }">
            <vessel-card
              v-for="vessel in mockVessels"
              :key="vessel.id"
              :vessel="vessel"
              :selected="selectedVesselId === vessel.id"
              @select="handleFocusVessel(vessel.id)"
              @inspect="handleInspectVessel(vessel.id)" />
          </div>
        </template>
      </n-flex>
    </div>
    <Console />
    <vessel-drawer
      v-model:show="showDrawer"
      :vessel="selectedVessel"
      :mock="true"
      @request-lease="handleRequestLease"
      @release-lease="handleReleaseLease" />
  </div>
</template>

<script setup lang="ts">
  // import { mdiPlusBox } from '@mdi/js'
  import { ref, computed, onMounted } from 'vue'
  import { NFlex, NText, NButton, NEmpty, NDivider } from 'naive-ui'
  import { VesselCard, VesselHero, VesselDrawer, provideConsole, Console } from '@qiln/engine/client'
  import type { WorkspaceVessel } from '@qiln/engine/client'
  import type { LogCategory } from '@qiln/engine/client'

  const consoleState = provideConsole()
  const showDrawer = ref(false)
  const mockVessels = ref<WorkspaceVessel[]>([
    {
      id: 'prod-vllm-01',
      name: 'prod-vllm-01',
      blueprint: 'vLLM Inference',
      status: 'online',
      ports: [{ name: 'API', port: 8000, protocol: 'tcp' }],
      cpu: 16,
      memory: '64GB',
      gpu: '4x RTX A4000',
      telemetry: {
        cpu: [45, 50, 48, 60, 80, 95, 110, 105, 112, 110, 90, 85, 88, 90, 100],
        memory: [42.1, 42.1, 42.1, 42.2, 42.2, 42.2, 42.2, 42.2, 42.2, 42.2, 42.2, 42.2, 42.2, 42.2, 42.2], // Raw GB
        network: [5, 12, 8, 45, 120, 150, 140, 90, 60, 40, 20, 15, 10, 5, 2],
        gpu: [10, 15, 12, 40, 85, 95, 100, 100, 100, 95, 80, 60, 40, 20, 10],
      },
      volumes: [
        { name: 'prod-vllm-01-models', size: '100GB' },
        { name: 'prod-vllm-01-cache', size: '50GB' },
      ],
      gpuLease: {
        status: 'attached',
        lease: {
          gpuType: 'RTX A4000',
          count: 4,
          vramUsedGB: 48,
          vramTotalGB: 16,
          tempCelsius: 68,
          utilization: 84,
          leasedSince: new Date(Date.now() - 4 * 86_400_000 - 12 * 3_600_000).toISOString(),
        },
      },
    },
    {
      id: 'comfy-workspace',
      name: 'comfy-workspace',
      blueprint: 'ComfyUI Workspace',
      status: 'offline',
      ports: [{ name: 'Web UI', port: 8188, protocol: 'tcp' }],
      cpu: 8,
      memory: '32GB',
      gpu: '1x RTX A4000',
      telemetry: {
        cpu: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        memory: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        network: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      volumes: [{ name: 'comfy-workspace-data', size: '200GB' }],
      gpuLease: { status: 'none' },
    },
    {
      id: 'research-jupyter',
      name: 'research-jupyter',
      blueprint: 'Jupyter PyTorch',
      status: 'online',
      ports: [{ name: 'Jupyter', port: 8888, protocol: 'tcp' }],
      cpu: 8,
      memory: '32GB',
      gpu: '1x RTX A4000',
      telemetry: {
        cpu: [10, 12, 11, 15, 14, 18, 16, 20, 25, 22, 20, 18, 15, 12, 10],
        memory: [12.4, 12.4, 12.4, 12.4, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5],
        network: [1, 2, 1, 5, 2, 1, 1, 3, 2, 1, 1, 1, 2, 1, 1],
        gpu: [0, 0, 0, 5, 10, 15, 12, 18, 20, 15, 10, 5, 0, 0, 0],
      },
      volumes: [{ name: 'research-jupyter-notebooks', size: '20GB' }],
      gpuLease: {
        status: 'attached',
        lease: {
          gpuType: 'RTX A4000',
          count: 1,
          vramUsedGB: 4,
          vramTotalGB: 16,
          tempCelsius: 42,
          utilization: 18,
          leasedSince: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
      },
    },
    {
      id: 'paper-survival',
      name: 'paper-survival',
      blueprint: 'PaperMC Server',
      status: 'starting',
      ports: [{ name: 'Game', port: 25565, protocol: 'tcp' }],
      cpu: 4,
      memory: '8GB',
      telemetry: {
        cpu: [10, 20, 40, 60, 80, 85, 90, 95, 98, 99, 100, 100, 100, 100, 100],
        memory: [1.2, 1.5, 2.1, 2.8, 3.5, 4.2, 4.8, 5.1, 5.4, 5.8, 6.1, 6.2, 6.2, 6.2, 6.2],
        network: [0, 0, 0, 1, 2, 5, 10, 15, 20, 25, 30, 28, 25, 20, 15],
      },
      volumes: [
        { name: 'paper-survival-world', size: '10GB' },
        { name: 'paper-survival-plugins', size: '2GB' },
      ],
      gpuLease: { status: 'requesting' },
    },
    {
      id: 'web-frontend',
      name: 'web-frontend',
      blueprint: 'Nginx Static',
      status: 'online',
      ports: [{ name: 'HTTP', port: 80, protocol: 'tcp' }],
      cpu: 2,
      memory: '1GB',
      telemetry: {
        cpu: [5, 4, 6, 5, 5, 4, 7, 8, 6, 5, 4, 5, 5, 6, 4],
        memory: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
        network: [10, 15, 12, 20, 18, 25, 30, 28, 22, 18, 15, 12, 10, 15, 12],
      },
      gpuLease: { status: 'ineligible' },
    },
    {
      id: 'database-node',
      name: 'database-node',
      blueprint: 'PostgreSQL 16',
      status: 'error',
      ports: [{ name: 'DB', port: 5432, protocol: 'tcp' }],
      cpu: 4,
      memory: '8GB',
      telemetry: {
        cpu: [30, 35, 40, 80, 90, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        memory: [4.5, 4.5, 4.5, 4.8, 5.1, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 5.5],
        network: [5, 8, 12, 45, 80, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      volumes: [{ name: 'database-node-pgdata', size: '50GB' }],
      gpuLease: { status: 'ineligible' },
    },
    {
      id: 'llama3-test',
      name: 'llama3-test',
      blueprint: 'vLLM Inference',
      status: 'online',
      ports: [{ name: 'API', port: 8000, protocol: 'tcp' }],
      cpu: 8,
      memory: '32GB',
      gpu: '2x RTX A4000',
      telemetry: {
        cpu: [20, 22, 21, 25, 24, 28, 26, 30, 35, 32, 30, 28, 25, 22, 20],
        memory: [18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5, 18.5],
        network: [2, 4, 3, 5, 4, 8, 6, 10, 15, 12, 8, 5, 4, 3, 2],
        gpu: [40, 45, 42, 50, 48, 55, 52, 60, 65, 62, 58, 50, 45, 42, 40],
      },
      gpuLease: {
        status: 'attached',
        lease: {
          gpuType: 'RTX A4000',
          count: 2,
          vramUsedGB: 22,
          vramTotalGB: 16,
          tempCelsius: 71,
          utilization: 62,
          leasedSince: new Date(Date.now() - 6 * 3_600_000).toISOString(),
        },
      },
    },
    {
      id: 'dev-sandbox',
      name: 'dev-sandbox',
      blueprint: 'VSCode Server',
      status: 'offline',
      ports: [{ name: 'IDE', port: 8080, protocol: 'tcp' }],
      cpu: 4,
      memory: '4GB',
      telemetry: {
        cpu: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        memory: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        network: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
      gpuLease: { status: 'releasing' },
    },
  ])

  const onlineCount = computed(() => {
    return mockVessels.value.filter(v => ['online', 'starting', 'stopping', 'provisioning'].includes(v.status)).length
  })

  const offlineCount = computed(() => {
    return mockVessels.value.filter(v => ['offline', 'error', 'archived'].includes(v.status)).length
  })

  const initialVessel = mockVessels.value.find(v => v.status === 'online') || mockVessels.value[0] || null
  const selectedVesselId = ref<string | null>(initialVessel?.id || null)

  const selectedVessel = computed(() => {
    return mockVessels.value.find(v => v.id === selectedVesselId.value) || null
  })

  function deriveLogCategory(blueprint: string): LogCategory {
    const lower = blueprint.toLowerCase()
    if (lower.includes('vllm')) return 'vllm'
    if (lower.includes('paper')) return 'minecraft'
    return 'generic'
  }

  function handleFocusVessel(id: string) {
    if (selectedVesselId.value === id && consoleState.tabs.value.length > 0) return
    selectedVesselId.value = id
    consoleState.clearTabs()
    const vessel = mockVessels.value.find(v => v.id === id)
    if (!vessel) return
    const category = deriveLogCategory(vessel.blueprint)
    consoleState.openVesselTab(`${id}-sys`, 'System', vessel.status, 'system')
    consoleState.openVesselTab(`${id}-app`, 'Application', vessel.status, category)
    consoleState.focusTab(`${id}-app`)
    if (!consoleState.isExpanded.value) {
      consoleState.isExpanded.value = true
    }
  }

  function handleInspectVessel(id: string) {
    handleFocusVessel(id)
    showDrawer.value = true
  }

  function handleStartVessel(id: string) {
    console.log(`[Workspace] Starting vessel: ${id}`)
  }

  function handleStopVessel(id: string) {
    console.log(`[Workspace] Stopping vessel: ${id}`)
  }

  function handleRestartVessel(id: string) {
    console.log(`[Workspace] Restarting vessel: ${id}`)
  }

  function handleDeleteVessel(id: string) {
    console.log(`[Workspace] Deleting vessel: ${id}`)
  }

  function handleOpenApp(id: string) {
    console.log(`[Workspace] Opening application for vessel: ${id}`)
  }

  function handleRequestLease(payload: { vesselId: string; gpuType: string; count: number }) {
    const vessel = mockVessels.value.find(v => v.id === payload.vesselId)
    if (!vessel) return
    vessel.gpuLease = { status: 'requesting' }
    setTimeout(() => {
      vessel.gpuLease = {
        status: 'attached',
        lease: {
          gpuType: payload.gpuType,
          count: payload.count,
          vramUsedGB: 0,
          vramTotalGB: 16,
          tempCelsius: 35,
          utilization: 0,
          leasedSince: new Date().toISOString(),
        },
      }
      const sysTabId = `${payload.vesselId}-sys`
      consoleState.pushLine(sysTabId, {
        id: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        source: 'GPU',
        sourceColor: '#22c55e',
        message: `PCIe device attached successfully. ${payload.count}x ${payload.gpuType} — VRAM: ${payload.count * 16}GB available.`,
      })
    }, 2000)
  }

  function handleReleaseLease(vesselId: string) {
    const vessel = mockVessels.value.find(v => v.id === vesselId)
    if (!vessel) return
    vessel.gpuLease = { status: 'releasing' }
    setTimeout(() => {
      vessel.gpuLease = { status: 'none' }
      const sysTabId = `${vesselId}-sys`
      consoleState.pushLine(sysTabId, {
        id: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        source: 'GPU',
        sourceColor: '#f59e0b',
        message: 'PCIe device detached. GPU lease released back to pool.',
      })
    }, 1500)
  }

  onMounted(() => {
    if (selectedVesselId.value) {
      handleFocusVessel(selectedVesselId.value)
    }
  })
</script>

<style scoped>
  .workspace-wrapper {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }

  .workspace-scroll-area {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
  }

  .fleet-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(318px, 1fr));
    transition: opacity 0.3s ease;
  }

  .grid-dimmed {
    opacity: 0.6;
  }
</style>
