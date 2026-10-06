<template>
  <div class="capsule-peek">
    <section class="peek-runtime" aria-label="Root branch runtime and capsule activity">
      <n-descriptions
        :column="1"
        separator="&nbsp;"
        label-placement="left"
        size="small"
        :label-style="{
          display: 'inline-block',
          boxSizing: 'border-box',
          width: '112px',
          marginRight: '12px',
          textAlign: 'left',
          verticalAlign: 'top',
        }"
        :content-style="{
          display: 'inline-block',
          boxSizing: 'border-box',
          width: 'calc(100% - 124px)',
          verticalAlign: 'top',
          overflowWrap: 'anywhere',
        }">
        <n-descriptions-item>
          <template #label>
            <n-tag size="small" bordered>Default Branch</n-tag>
          </template>
          <n-text>{{ branchStates[summary.rootBranch.status].label }}</n-text>
        </n-descriptions-item>
        <n-descriptions-item>
          <template #label>
            <n-tag size="small" bordered>IP Address</n-tag>
          </template>
          <n-text v-if="summary.rootBranch.runtimeIp !== null" code>{{ summary.rootBranch.runtimeIp }}</n-text>
          <n-text v-else depth="3">None</n-text>
        </n-descriptions-item>
        <n-descriptions-item>
          <template #label>
            <n-tag size="small" bordered>Activity</n-tag>
          </template>
          <n-text v-if="summary.currentOperation === null" depth="3">None</n-text>
          <n-flex v-else vertical :size="4">
            <n-text>{{ operationLabels[summary.currentOperation.type] }}</n-text>
            <n-text depth="3">{{ operationStates[summary.currentOperation.status].label }}</n-text>
            <n-text depth="3">May target a different branch.</n-text>
          </n-flex>
        </n-descriptions-item>
      </n-descriptions>
    </section>
    <section class="peek-applications" aria-label="Root branch applications">
      <n-text v-if="summary.previews === null" depth="3">Historical application evidence unavailable.</n-text>
      <n-text v-else-if="summary.previews.length === 0" depth="3">No preview records for this root branch.</n-text>
      <n-flex v-else vertical :size="12" role="list">
        <n-flex
          v-for="preview in summary.previews"
          :key="preview.id"
          justify="space-between"
          align="center"
          :size="12"
          role="listitem">
          <n-flex vertical align="flex-start" :size="4">
            <n-text>{{ applicationLabel(preview.applicationName) }}</n-text>
            <n-tag size="small" :bordered="false" :type="previewStates[preview.status].tone">
              {{ previewStates[preview.status].label }}
            </n-tag>
          </n-flex>
          <template v-if="preview.status === 'active'">
            <n-button
              v-if="preview.previewUrl !== null && refreshError === null"
              tag="a"
              :href="preview.previewUrl"
              target="_blank"
              rel="noopener noreferrer"
              secondary
              size="small"
              :aria-label="`Open ${applicationLabel(preview.applicationName)} in a new tab`">
              <template #icon>
                <icon :path="mdiOpenInNew" :size="14" aria-hidden="true" />
              </template>
              Open
            </n-button>
            <n-text v-else depth="3">Link unavailable</n-text>
          </template>
        </n-flex>
      </n-flex>
    </section>
    <section class="peek-controls" aria-label="Root branch controls">
      <capsule-controls
        :capsule="summary.capsule"
        :branch="summary.rootBranch"
        :current-operation="summary.currentOperation" />
    </section>
  </div>
</template>

<script setup lang="ts">
  import { NButton, NDescriptions, NDescriptionsItem, NFlex, NTag, NText } from 'naive-ui'
  import { mdiOpenInNew } from '@mdi/js'
  import type { CapsuleSummary } from '@qiln/core/client'
  import { useCapsuleContext } from '../../composables/useCapsules'
  import { Icon } from '../Icon'
  import CapsuleControls from './CapsuleBranchControls.vue'
  import { applicationLabel, branchStates, operationLabels, operationStates, previewStates } from './state'

  defineProps<{
    summary: CapsuleSummary
  }>()

  const { refreshError } = useCapsuleContext()
</script>

<style scoped>
  .capsule-peek {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    min-width: 0;
    box-sizing: border-box;
    padding-inline-start: 40px;
  }

  .peek-runtime,
  .peek-applications,
  .peek-controls {
    min-width: 0;
  }

  .peek-runtime-descriptions :deep(.n-descriptions-table-content__label) {
    width: 132px;
  }

  @media (min-width: 1100px) {
    .capsule-peek {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.6fr) minmax(0, 0.3fr);
      gap: 24px;
    }
  }
</style>
