<template>
  <n-flex vertical :size="20" class="capsule-page">
    <nav aria-label="Capsule navigation">
      <a-link href="/admin/capsules" class="back-link">
        <icon :path="mdiArrowLeft" :size="16" aria-hidden="true" />
        <span>Back to capsules</span>
      </a-link>
    </nav>
    <capsule-detail-dashboard :key="detail.branch.id" :detail="detail" />
  </n-flex>
</template>

<script setup lang="ts">
  import { onUnmounted, ref, watch } from 'vue'
  import { NFlex } from 'naive-ui'
  import { mdiArrowLeft } from '@mdi/js'
  import { ALink } from '@/components/ALink'
  import { Icon } from '@/components/Icon'
  import { useCapsuleEventStream } from '@/composables/useCapsuleEventStream'
  import { useData } from '@/composables/useData'
  import { usePageContext } from '@/composables/usePageContext'
  import { useTRPC } from '@/composables/useTRPC'
  import { CapsuleDetailDashboard, provideCapsules } from '@qiln/engine/client'
  import type { CapsuleDetail } from '@qiln/core/client'
  import type { Data } from './+data'

  const data = useData<Data>()
  const pageContext = usePageContext()
  const trpc = useTRPC(pageContext.value)
  const detail = ref<CapsuleDetail>(data.value.detail)
  let disposed = false

  const { onEventStream } = useCapsuleEventStream(refreshAfterConnection)
  const capsuleContext = provideCapsules({
    client: trpc.engine.capsules,
    refresh: refreshDetail,
    isEventRelevant: event => event.capsuleId === pageContext.value.routeParams?.capsuleId,
    onError: error => {
      console.error('[Qiln Admin] Capsule detail refresh failed:', error)
    },
    onEventStream,
  })

  watch(
    () => data.value.detail,
    nextDetail => {
      if (nextDetail !== undefined) {
        detail.value = nextDetail
      }
    },
  )

  async function refreshDetail(): Promise<void> {
    const scope = pageContext.value
    const capsuleId = scope.routeParams?.capsuleId
    if (!capsuleId) {
      return
    }
    try {
      const nextDetail = await trpc.engine.capsules.detail.query({
        capsuleId,
      })
      // Vike can reuse this page for another capsule while a read is pending.
      if (!disposed && pageContext.value === scope) {
        detail.value = nextDetail
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

  onUnmounted(() => {
    disposed = true
  })
</script>

<style scoped>
  .capsule-page {
    max-width: 1440px;
    min-width: 0;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: inherit;
    font-size: 13px;
    text-decoration: none;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  .back-link:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 4px;
    border-radius: 3px;
  }
</style>
