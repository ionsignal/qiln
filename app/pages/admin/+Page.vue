<template>
  <n-flex vertical :size="48">
    <n-flex vertical :size="24">
      <n-flex justify="space-between" align="center">
        <div>
          <h1 style="margin: 0; font-size: 24px; font-weight: 600">Fleet Overview</h1>
          <n-text depth="3">Manage your active container instances.</n-text>
        </div>
        <n-button type="primary" @click="openProvisioner()">Provision Vessel</n-button>
      </n-flex>
      <div v-if="instancesRef.length === 0">
        <n-empty description="No instances running. Deploy a blueprint to get started." style="margin-top: 48px" />
      </div>
      <div v-else class="admin-grid">
        <instance-card v-for="inst in instancesRef" :key="inst.name" :instance="inst" />
      </div>
    </n-flex>
    <n-divider />
    <n-flex vertical :size="24">
      <div>
        <h2 style="margin: 0; font-size: 20px; font-weight: 600">Mold Registry (Blueprints)</h2>
        <n-text depth="3">Available application definitions ready for deployment.</n-text>
      </div>
      <div class="admin-grid">
        <blueprint-card v-for="bp in data.blueprints" :key="bp.name" :blueprint="bp" @deploy="openProvisioner" />
      </div>
    </n-flex>
    <instance-editor v-model:show="showDrawer" :blueprints="data.blueprints" :preselected-blueprint="selectedBlueprint" />
  </n-flex>
</template>

<script setup lang="ts">
  import { ref, watch, onMounted, onUnmounted } from 'vue'
  import { NFlex, NText, NButton, NEmpty, NDivider } from 'naive-ui'
  import { useData } from '@/composables/useData'
  import { trpc } from '@/renderer/api/trpc'
  import { InstanceCard, BlueprintCard, InstanceEditor, provideInstances } from '@qiln/engine/client'
  import type { Data } from './+data'

  const data = useData<Data>()
  const instancesRef = ref(data.value.instances)
  const showDrawer = ref(false)
  const selectedBlueprint = ref<string | undefined>(undefined)

  watch(
    () => data.value.instances,
    newInstances => {
      instancesRef.value = newInstances
    },
    { deep: false },
  )

  function openProvisioner(blueprintName?: string) {
    selectedBlueprint.value = blueprintName
    showDrawer.value = true
  }

  const streamHandlers = new Set<(rawEvent: unknown) => void>()
  let streamSubscription: ReturnType<typeof trpc.stream.events.subscribe> | null = null

  onMounted(() => {
    streamSubscription = trpc.stream.events.subscribe(undefined, {
      onStarted: () => console.log('[Qiln Admin] Connected to Event Stream'),
      onData: eventData => {
        streamHandlers.forEach(handler => handler(eventData))
      },
      onError: (err: unknown) => console.error('[Qiln Admin] Stream Error:', err),
      onStopped: () => console.log('[Qiln Admin] Stream Stopped'),
    })
  })

  onUnmounted(() => {
    if (streamSubscription) {
      streamSubscription.unsubscribe()
    }
  })

  const registerStreamHandler = (handler: (rawEvent: unknown) => void) => {
    streamHandlers.add(handler)
    return { unsubscribe: () => streamHandlers.delete(handler) }
  }

  provideInstances({
    client: trpc.host.instance,
    instances: instancesRef,
    onError: err => console.error('[Qiln Admin] Instance sync error:', err),
    onEventStream: registerStreamHandler,
  })
</script>

<style scoped>
  .admin-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: 1fr;
  }

  @media (min-width: 640px) {
    .admin-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (min-width: 1024px) {
    .admin-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (min-width: 1440px) {
    .admin-grid {
      grid-template-columns: repeat(4, 1fr);
    }
  }
</style>
