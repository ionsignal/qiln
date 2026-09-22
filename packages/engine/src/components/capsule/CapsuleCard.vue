<template>
  <n-card embedded size="small" class="capsule-card">
    <template #header>
      <div class="card-heading">
        <span class="card-title">Capsule</span>
        <code class="capsule-id" :title="summary.capsule.capsuleId">
          {{ shortId(summary.capsule.capsuleId) }}
        </code>
      </div>
    </template>
    <n-flex vertical :size="16">
      <div class="branch-identity">
        <n-text depth="3" class="field-label">Root branch s</n-text>
        <n-text strong class="branch-name">{{ summary.rootBranch.name }}</n-text>
      </div>
      <dl class="state-list">
        <div class="state-row">
          <dt>Capsule lifecycle</dt>
          <dd>
            <n-tag size="small" :bordered="false" :type="lifecycle.tone">
              {{ lifecycle.label }}
            </n-tag>
            <n-tag v-if="summary.capsule.archivedAt !== null" size="small" :bordered="false">Archived</n-tag>
          </dd>
        </div>
        <div class="state-row">
          <dt>Root branch runtime</dt>
          <dd>
            <n-tag size="small" :bordered="false" :type="runtime.tone">
              {{ runtime.label }}
            </n-tag>
          </dd>
        </div>
        <div class="state-row">
          <dt>Preview</dt>
          <dd>
            <n-text v-if="summary.previews === null" depth="3">Evidence unavailable</n-text>
            <n-text v-else-if="summary.previews.length === 0" depth="3">No preview records</n-text>
            <template v-else>
              <n-tag
                v-for="preview in summary.previews"
                :key="preview.id"
                size="small"
                :bordered="false"
                :type="previewStates[preview.status].tone">
                {{ preview.applicationName }} · {{ previewStates[preview.status].label }}
              </n-tag>
            </template>
          </dd>
        </div>
        <div class="state-row">
          <dt>Current operation</dt>
          <dd>
            <n-text v-if="summary.currentOperation === null" depth="3">None</n-text>
            <template v-else>
              <n-text>{{ operationLabels[summary.currentOperation.type] }}</n-text>
              <n-tag size="small" :bordered="false" :type="operationStates[summary.currentOperation.status].tone">
                {{ operationStates[summary.currentOperation.status].label }}
              </n-tag>
            </template>
          </dd>
        </div>
      </dl>
    </n-flex>
    <template #action>
      <n-button
        block
        secondary
        size="small"
        :aria-label="`View capsule with root branch ${summary.rootBranch.name}`"
        @click="emit('view-capsule', summary.capsule.capsuleId)">
        View capsule
      </n-button>
    </template>
  </n-card>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { NButton, NCard, NFlex, NTag, NText } from 'naive-ui'
  import type { CapsuleSummary } from '@qiln/core/client'
  import { branchStates, lifecycleStates, operationLabels, operationStates, previewStates, shortId } from './state'

  defineOptions({
    name: 'CapsuleCard',
  })

  const props = defineProps<{
    summary: CapsuleSummary
  }>()

  const emit = defineEmits<{
    (event: 'view-capsule', capsuleId: string): void
  }>()

  const lifecycle = computed(() => lifecycleStates[props.summary.capsule.lifecycleStatus])
  const runtime = computed(() => branchStates[props.summary.rootBranch.status])
</script>

<style scoped>
  .capsule-card {
    height: 100%;
    min-width: 0;
  }

  .card-heading,
  .state-row dd {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .card-heading {
    justify-content: space-between;
  }

  .card-title {
    font-size: 16px;
    font-weight: 600;
  }

  .capsule-id {
    font-size: 11px;
    font-weight: 400;
    opacity: 0.55;
  }

  .branch-identity {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label,
  .state-row dt {
    font-size: 12px;
  }

  .branch-name {
    font-size: 18px;
    overflow-wrap: anywhere;
  }

  .state-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
  }

  .state-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .state-row dt {
    opacity: 0.6;
  }

  .state-row dd {
    margin: 0;
    font-size: 13px;
  }
</style>
