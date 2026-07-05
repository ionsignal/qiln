<template>
  <n-flex vertical :size="28" class="capsules-page">
    <n-flex justify="space-between" align="center">
      <div>
        <h1 class="page-title">Capsules</h1>
        <n-text depth="3">Create, branch, test, promote, and roll back versioned AI workflow systems.</n-text>
      </div>
      <n-button type="primary" size="small" color="white" strong @click="openCreateDrawer()">
        Create Branch
        <template #icon><icon :path="mdiPlus" /></template>
      </n-button>
    </n-flex>

    <div class="summary-grid">
      <n-card embedded size="small" class="summary-card">
        <n-text depth="3" class="summary-label">Capsule Branches</n-text>
        <div class="summary-value">{{ branchCount }}</div>
      </n-card>
      <n-card embedded size="small" class="summary-card">
        <n-text depth="3" class="summary-label">Online Branches</n-text>
        <div class="summary-value">{{ onlineBranchCount }}</div>
      </n-card>
      <n-card embedded size="small" class="summary-card">
        <n-text depth="3" class="summary-label">Capsule Blueprints</n-text>
        <div class="summary-value">{{ blueprintCount }}</div>
      </n-card>
    </div>

    <n-card embedded size="small" class="lifecycle-card">
      <template #header>
        <n-text class="section-title">Capsule lifecycle</n-text>
      </template>
      <n-flex vertical :size="10">
        <n-text depth="3" style="font-size: 13px">
          Current working slice: create branch, observe branch state, and start/stop/delete branches through the real capsule channel.
        </n-text>
        <n-flex :size="8" wrap>
          <n-tag size="small" :bordered="false" type="info">Snapshot</n-tag>
          <n-tag size="small" :bordered="false" type="info">Golden Test</n-tag>
          <n-tag size="small" :bordered="false" type="info">Diff</n-tag>
          <n-tag size="small" :bordered="false" type="info">Route Alias</n-tag>
          <n-tag size="small" :bordered="false" type="info">Promote</n-tag>
          <n-tag size="small" :bordered="false" type="info">Rollback</n-tag>
        </n-flex>
      </n-flex>
    </n-card>

    <n-flex vertical :size="18">
      <n-flex justify="space-between" align="center">
        <div>
          <h2 class="section-heading">Capsule Branches</h2>
          <n-text depth="3">Editable forks of durable capsule versions. Production is promoted, not edited directly.</n-text>
        </div>
      </n-flex>

      <div v-if="branchesRef.length === 0">
        <n-empty description="No capsule branches yet. Create a branch from a capsule blueprint to begin." class="empty-state" />
      </div>
      <div v-else class="branch-grid">
        <capsule-branch-card v-for="branch in branchesRef" :key="branch.id" :branch="branch" />
      </div>
    </n-flex>

    <n-divider />

    <n-flex vertical :size="18">
      <div>
        <h2 class="section-heading">Capsule Blueprints</h2>
        <n-text depth="3">Supported capsule templates available for branch creation.</n-text>
      </div>

      <div v-if="blueprints.length === 0">
        <n-empty description="No capsule blueprints are currently loaded." class="empty-state" />
      </div>
      <div v-else class="blueprint-grid">
        <blueprint-card v-for="blueprint in blueprints" :key="blueprint.name" :blueprint="blueprint" @create-branch="openCreateDrawer" />
      </div>
    </n-flex>

    <capsule-branch-create-drawer v-model:show="showDrawer" :blueprints="blueprints" :preselected-blueprint="selectedBlueprint" />
  </n-flex>
</template>

<script setup lang="ts">
  import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
  import { NButton, NFlex, NText, NEmpty, NDivider, NCard, NTag } from 'naive-ui'
  import { mdiPlus } from '@mdi/js'
  import { Icon } from '@/components/Icon'
  import { useData } from '@/composables/useData'
  import { usePageContext } from '@/composables/usePageContext'
  import { useTRPC } from '@/composables/useTRPC'
  import { CapsuleBranchCard, BlueprintCard, CapsuleBranchCreateDrawer, provideCapsules } from '@qiln/engine/client'
  import type { CapsuleBranchItem } from '@qiln/engine/client'
  import type { Data } from './+data'

  const data = useData<Data>()
  const pageContext = usePageContext()
  const trpc = useTRPC(pageContext.value)

  const branchesRef = ref<CapsuleBranchItem[]>(data.value.branches)
  const showDrawer = ref(false)
  const selectedBlueprint = ref<string | undefined>(undefined)

  const blueprints = computed(() => data.value.blueprints)
  const branchCount = computed(() => branchesRef.value.length)
  const onlineBranchCount = computed(() => branchesRef.value.filter((branch: any) => branch.status === 'online').length)
  const blueprintCount = computed(() => blueprints.value.length)

  const streamHandlers = new Set<(rawEvent: unknown) => void>()
  let streamSubscription: ReturnType<typeof trpc.stream.events.subscribe> | null = null

  const registerStreamHandler = (handler: (rawEvent: unknown) => void) => {
    streamHandlers.add(handler)
    return {
      unsubscribe: () => {
        streamHandlers.delete(handler)
      },
    }
  }

  provideCapsules({
    client: trpc.engine.capsules,
    branches: branchesRef,
    onError: err => console.error('[Qiln Admin] Capsule branch sync error:', err),
    onEventStream: registerStreamHandler,
  })

  watch(
    () => data.value.branches,
    newBranches => {
      branchesRef.value = newBranches
    },
    { deep: false },
  )

  function openCreateDrawer(blueprintName?: string) {
    selectedBlueprint.value = blueprintName
    showDrawer.value = true
  }

  onMounted(() => {
    streamSubscription = trpc.stream.events.subscribe(undefined, {
      onStarted: () => console.log('[Qiln Admin] Connected to capsule event stream'),
      onData: eventData => {
        streamHandlers.forEach(handler => handler(eventData))
      },
      onError: (err: unknown) => console.error('[Qiln Admin] Capsule stream error:', err),
      onStopped: () => console.log('[Qiln Admin] Capsule event stream stopped'),
    })
  })

  onUnmounted(() => {
    streamSubscription?.unsubscribe()
    streamSubscription = null
    streamHandlers.clear()
  })
</script>

<style scoped>
  .capsules-page {
    max-width: 1440px;
  }

  .page-title {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
  }

  .section-heading {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  .section-title {
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .summary-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }

  .summary-card {
    min-height: 88px;
  }

  .summary-label {
    display: block;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .summary-value {
    margin-top: 8px;
    font-size: 28px;
    font-weight: 700;
    line-height: 1;
  }

  .lifecycle-card {
    border-color: rgba(10, 132, 255, 0.25);
  }

  .branch-grid,
  .blueprint-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: 1fr;
  }

  .empty-state {
    margin-top: 32px;
  }

  @media (min-width: 720px) {
    .branch-grid,
    .blueprint-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (min-width: 1120px) {
    .branch-grid,
    .blueprint-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (min-width: 1480px) {
    .branch-grid,
    .blueprint-grid {
      grid-template-columns: repeat(4, 1fr);
    }
  }
</style>
