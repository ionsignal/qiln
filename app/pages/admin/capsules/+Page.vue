<template>
  <n-flex vertical :size="28" class="capsules-page">
    <n-flex justify="space-between" align="center" :size="16">
      <div>
        <h1 class="page-title">Capsules</h1>
        <n-text depth="3">Versioned AI workflow systems with isolated editable branches.</n-text>
      </div>
      <n-button type="primary" size="small" color="white" strong @click="openCreateDrawer()">
        Create Capsule
        <template #icon>
          <icon :path="mdiPlus" />
        </template>
      </n-button>
    </n-flex>
    <div class="summary-grid">
      <n-card embedded size="small" class="summary-card">
        <n-text depth="3" class="summary-label">Capsules</n-text>
        <div class="summary-value">{{ capsuleCount }}</div>
      </n-card>
      <n-card embedded size="small" class="summary-card">
        <n-text depth="3" class="summary-label">Online Root Branches</n-text>
        <div class="summary-value">{{ onlineRootCount }}</div>
      </n-card>
      <n-card embedded size="small" class="summary-card">
        <n-text depth="3" class="summary-label">Capsule Blueprints</n-text>
        <div class="summary-value">{{ blueprintCount }}</div>
      </n-card>
    </div>
    <n-alert v-if="refreshError !== null" type="warning" title="Displayed state may be out of date">
      <n-flex vertical :size="10">
        <span>
          Qiln could not refresh the capsule index. The last loaded state is still displayed. An accepted operation is
          not undone by a refresh failure.
        </span>
        <div>
          <n-button size="small" :loading="refreshing" @click="retryRefresh">Refresh capsules</n-button>
        </div>
      </n-flex>
    </n-alert>
    <n-flex vertical :size="18">
      <n-flex justify="space-between" align="center" :size="16">
        <div>
          <h2 class="section-heading">Your capsules</h2>
          <n-text depth="3">
            Inspect capsule lifecycle, root branch runtime, previews, and current operations. Archived and destroyed
            capsules remain visible.
          </n-text>
        </div>
        <n-button size="small" secondary :loading="refreshing" @click="retryRefresh">
          <template #icon>
            <icon :path="mdiRefresh" :size="16" />
          </template>
          Refresh
        </n-button>
      </n-flex>
      <div v-if="capsules.length === 0">
        <n-empty description="No capsules yet. Create a capsule from a blueprint to begin." class="empty-state" />
      </div>
      <div v-else class="capsule-grid">
        <capsule-card
          v-for="capsule in capsules"
          :key="capsule.capsule.capsuleId"
          :summary="capsule"
          @view-capsule="viewCapsule" />
      </div>
    </n-flex>
    <n-divider />
    <n-flex vertical :size="18">
      <div>
        <h2 class="section-heading">Capsule Blueprints</h2>
        <n-text depth="3">Supported capsule templates available for capsule creation.</n-text>
      </div>
      <div v-if="blueprints.length === 0">
        <n-empty description="No capsule blueprints are currently loaded." class="empty-state" />
      </div>
      <div v-else class="blueprint-grid">
        <blueprint-card
          v-for="blueprint in blueprints"
          :key="blueprint.name"
          :blueprint="blueprint"
          @create-capsule="openCreateDrawer" />
      </div>
    </n-flex>
    <capsule-create-drawer
      v-model:show="showDrawer"
      :blueprints="blueprints"
      :preselected-blueprint="selectedBlueprint" />
  </n-flex>
</template>

<script setup lang="ts">
  import { computed, onUnmounted, ref, watch } from 'vue'
  import { NAlert, NButton, NCard, NDivider, NEmpty, NFlex, NText, useMessage } from 'naive-ui'
  import { mdiPlus, mdiRefresh } from '@mdi/js'
  import { navigate } from 'vike/client/router'
  import { Icon } from '@/components/Icon'
  import { useCapsuleEventStream } from '@/composables/useCapsuleEventStream'
  import { useData } from '@/composables/useData'
  import { usePageContext } from '@/composables/usePageContext'
  import { useTRPC } from '@/composables/useTRPC'
  import { BlueprintCard, CapsuleCard, CapsuleCreateDrawer, provideCapsules } from '@qiln/engine/client'
  import type { CapsuleListOutput } from '@qiln/core/client'
  import type { Data } from './+data'

  const data = useData<Data>()
  const pageContext = usePageContext()
  const trpc = useTRPC(pageContext.value)
  const message = useMessage()

  const capsules = ref<CapsuleListOutput>(data.value.capsules)
  const showDrawer = ref(false)
  const selectedBlueprint = ref<string | undefined>(undefined)
  let disposed = false

  const blueprints = computed(() => data.value.manifest.blueprints)
  const capsuleCount = computed(() => capsules.value.length)
  const onlineRootCount = computed(
    () => capsules.value.filter(capsule => capsule.rootBranch.status === 'online').length,
  )
  const blueprintCount = computed(() => blueprints.value.length)

  const { onEventStream } = useCapsuleEventStream(refreshAfterConnection)
  const capsuleContext = provideCapsules({
    client: trpc.engine.capsules,
    refresh: refreshCapsules,
    onError: error => {
      console.error('[Qiln Admin] Capsule index refresh failed:', error)
    },
    onEventStream,
  })
  const { refreshing, refreshError } = capsuleContext

  watch(
    () => data.value.capsules,
    nextCapsules => {
      if (nextCapsules !== undefined) {
        capsules.value = nextCapsules
      }
    },
  )

  async function refreshCapsules(): Promise<void> {
    const scope = pageContext.value
    try {
      const nextCapsules = await trpc.engine.capsules.list.query()
      // A read from an earlier navigation must not overwrite newly hydrated state.
      if (!disposed && pageContext.value === scope) {
        capsules.value = nextCapsules
      }
    } catch (error: unknown) {
      if (!disposed && pageContext.value === scope) {
        throw error
      }
    }
  }

  function refreshAfterConnection(): Promise<void> {
    return capsuleContext.refresh()
  }

  async function retryRefresh(): Promise<void> {
    try {
      await capsuleContext.refresh()
    } catch {
      message.error('The capsule index could not be refreshed. Please try again.')
    }
  }

  function openCreateDrawer(blueprintName?: string): void {
    selectedBlueprint.value = blueprintName
    showDrawer.value = true
  }

  function viewCapsule(capsuleId: string): void {
    void navigate(`/admin/capsules/${encodeURIComponent(capsuleId)}`)
  }

  onUnmounted(() => {
    disposed = true
  })
</script>

<style scoped>
  .capsules-page {
    max-width: 1440px;
    min-width: 0;
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

  .capsule-grid,
  .blueprint-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(0, 1fr);
  }

  .empty-state {
    margin-top: 32px;
  }

  @media (min-width: 720px) {
    .capsule-grid,
    .blueprint-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (min-width: 1120px) {
    .capsule-grid,
    .blueprint-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (min-width: 1480px) {
    .capsule-grid,
    .blueprint-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
</style>
