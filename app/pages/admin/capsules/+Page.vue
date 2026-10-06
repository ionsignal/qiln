<template>
  <n-flex vertical :size="28" class="capsules-page">
    <section aria-labelledby="capsules-heading" class="capsules-overview">
      <div class="toolbar-heading">
        <h1 id="capsules-heading" class="page-title">Capsules</h1>
        <n-tag size="small" :bordered="false" :aria-label="`${capsules.length} capsules`">
          {{ capsules.length }}
        </n-tag>
      </div>
      <n-text depth="3" class="overview-description">
        Runtime, previews, and current activity. Expand a capsule for quick controls.
      </n-text>
      <n-alert v-if="refreshError !== null" type="warning" title="Displayed state may be out of date">
        <n-flex vertical :size="10">
          <span>
            Qiln could not refresh the capsule index. The last loaded state is still displayed. Runtime actions and
            preview links are unavailable until state is refreshed. An accepted operation is not undone by a refresh
            failure.
          </span>
          <div>
            <n-button size="small" :loading="refreshing" @click="retryRefresh">Refresh capsules</n-button>
          </div>
        </n-flex>
      </n-alert>
      <n-text v-if="search.trim()" depth="3" class="search-summary" role="status" aria-live="polite">
        Showing {{ filteredCapsules.length }} of {{ capsules.length }} capsules
      </n-text>
      <n-space align="center" justify="end" :size="10" :wrap-item="false">
        <n-input
          v-model:value="search"
          clearable
          autosize
          size="small"
          style="min-width: 312px"
          placeholder="Search root branches or capsule IDs">
          <template #prefix>
            <icon :path="mdiMagnify" :size="16" aria-hidden="true" />
          </template>
        </n-input>
        <n-button-group>
          <n-button secondary size="small" :loading="refreshing" @click="retryRefresh">
            <template #icon>
              <icon :path="mdiRefresh" :size="16" aria-hidden="true" />
            </template>
          </n-button>
          <n-button type="primary" size="small" color="#cccccc" strong @click="openCreateDrawer()">
            Create capsule
            <template #icon>
              <icon :path="mdiPlus" :size="16" aria-hidden="true" />
            </template>
          </n-button>
        </n-button-group>
      </n-space>
      <capsule-table
        :capsules="filteredCapsules"
        :detail-href="capsuleHref"
        :empty-description="emptyDescription"
        @view-capsule="viewCapsule" />
      <div v-if="capsules.length > 0 && filteredCapsules.length === 0">
        <n-button size="small" secondary @click="search = ''">Clear search</n-button>
      </div>
    </section>
    <!-- <n-divider />
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
    </n-flex> -->
    <capsule-create-drawer
      v-model:show="showDrawer"
      :blueprints="blueprints"
      :preselected-blueprint="selectedBlueprint" />
  </n-flex>
</template>

<script setup lang="ts">
  import { computed, onUnmounted, ref, watch } from 'vue'
  import { NAlert, NButton, NButtonGroup, NFlex, NInput, NSpace, NTag, NText, useMessage } from 'naive-ui' // NDivider, NEmpty,
  import { mdiMagnify, mdiPlus, mdiRefresh } from '@mdi/js'
  import { navigate } from 'vike/client/router'
  import { Icon } from '@/components/Icon'
  import { useCapsuleEventStream } from '@/composables/useCapsuleEventStream'
  import { useData } from '@/composables/useData'
  import { usePageContext } from '@/composables/usePageContext'
  import { useTRPC } from '@/composables/useTRPC'
  import { CapsuleCreateDrawer, CapsuleTable, provideCapsules } from '@qiln/engine/client' // BlueprintCard,
  import type { CapsuleListOutput } from '@qiln/core/client'
  import type { Data } from './+data'

  const data = useData<Data>()
  const pageContext = usePageContext()
  const trpc = useTRPC(pageContext.value)
  const message = useMessage()

  const capsules = ref<CapsuleListOutput>(data.value.capsules)
  const search = ref('')
  const showDrawer = ref(false)
  const selectedBlueprint = ref<string | undefined>(undefined)

  const blueprints = computed(() => data.value.manifest.blueprints)
  const filteredCapsules = computed(() => {
    const query = search.value.trim().toLowerCase()
    if (!query) {
      return capsules.value
    }
    return capsules.value.filter(
      summary =>
        summary.rootBranch.name.toLowerCase().includes(query) ||
        summary.capsule.capsuleId.toLowerCase().includes(query),
    )
  })
  const emptyDescription = computed(() =>
    capsules.value.length === 0
      ? 'No capsules yet. Create a capsule from a blueprint to begin.'
      : 'No capsules match your search.',
  )

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

  let disposed = false
  async function refreshCapsules(): Promise<void> {
    const scope = pageContext.value
    try {
      const nextCapsules = await trpc.engine.capsules.list.query()
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

  function capsuleHref(capsuleId: string): string {
    return `/admin/capsules/${encodeURIComponent(capsuleId)}`
  }

  function viewCapsule(capsuleId: string): void {
    void navigate(capsuleHref(capsuleId))
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

  .capsules-overview {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .toolbar-heading {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* 
  .blueprint-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(0, 1fr);
  }
  .empty-state {
    margin-top: 32px;
  }

  @media (min-width: 720px) {
    .blueprint-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (min-width: 1120px) {
    .blueprint-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (min-width: 1480px) {
    .blueprint-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  } */
</style>
