<template>
  <n-data-table
    class="capsule-table"
    size="medium"
    :columns="columns"
    :data="capsules"
    :row-key="rowKey"
    :expanded-row-keys="expandedCapsuleIds"
    :render-expand-icon="renderExpandIcon"
    :bordered="true"
    :single-line="true"
    @update:expanded-row-keys="updateExpandedCapsuleIds">
    <template #empty>
      <n-empty :description="emptyDescription" />
    </template>
  </n-data-table>
</template>

<script setup lang="ts">
  import { computed, h, ref, watch } from 'vue'
  import {
    NButton,
    NDataTable,
    NDropdown,
    NEmpty,
    NFlex,
    NTag,
    NText,
    type DataTableColumns,
    type DropdownOption,
  } from 'naive-ui'
  import { mdiChevronDown, mdiChevronRight, mdiOpenInNew } from '@mdi/js'
  import type { CapsuleSummary } from '@qiln/core/client'
  import { useCapsuleContext } from '../../composables/useCapsules'
  import { Icon } from '../Icon'
  import CapsulePeek from './CapsulePeek.vue'
  import {
    applicationLabel,
    branchStates,
    lifecycleExceptions,
    openablePreviews,
    operationLabels,
    operationStates,
    previewSummary,
  } from './state'

  const props = defineProps<{
    capsules: CapsuleSummary[]
    detailHref: (capsuleId: string) => string
    emptyDescription: string
  }>()

  const emit = defineEmits<{
    (event: 'view-capsule', capsuleId: string): void
  }>()

  const { refreshError } = useCapsuleContext()
  const expandedCapsuleIds = ref<string[]>([])

  watch(
    () => props.capsules,
    capsules => {
      const visibleIds = new Set(capsules.map(summary => summary.capsule.capsuleId))
      expandedCapsuleIds.value = expandedCapsuleIds.value.filter(id => visibleIds.has(id))
    },
  )

  const columns = computed<DataTableColumns<CapsuleSummary>>(() => [
    {
      type: 'expand',
      width: 40,
      renderExpand: summary =>
        h(CapsulePeek, {
          key: summary.capsule.capsuleId,
          summary,
        }),
    },
    {
      title: 'Promoted Capsule Branch',
      key: 'identity',
      render: summary =>
        h(NFlex, { align: 'center', size: 6 }, () => [
          h(NText, { strong: true, class: 'capsule-name' }, () => summary.rootBranch.name),
          ...lifecycleExceptions(summary.capsule).map(state =>
            h(
              NTag,
              {
                key: state.label,
                size: 'small',
                bordered: false,
                type: state.tone,
                'aria-label': `Capsule: ${state.label}`,
              },
              () => state.label,
            ),
          ),
        ]),
    },
    {
      title: 'Runtime',
      key: 'runtime',
      render: summary => {
        const state = branchStates[summary.rootBranch.status]
        return h(NFlex, { inline: true, align: 'center', size: 7, wrap: false }, () => [
          h('span', {
            class: 'runtime-dot',
            'data-tone': state.tone,
            'aria-hidden': true,
          }),
          h(NText, null, () => state.label),
        ])
      },
    },
    {
      title: 'Preview',
      key: 'previews',
      render: summary => {
        const state = previewSummary(summary.previews)
        return h(
          NText,
          {
            depth: state.tone === 'default' ? 3 : undefined,
            type: state.tone === 'warning' || state.tone === 'error' ? state.tone : 'default',
          },
          () => state.label,
        )
      },
    },
    {
      title: 'Activity',
      key: 'operation',
      render: summary => {
        const operation = summary.currentOperation
        if (operation === null) {
          return h(NText, { depth: 3, 'aria-label': 'No current operation' }, () => '—')
        }
        return h(NFlex, { vertical: true, size: 2 }, () => [
          h(NText, null, () => operationLabels[operation.type]),
          h(NText, { depth: 3 }, () => operationStates[operation.status].label),
        ])
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      align: 'right',
      render: summary => {
        const previews = refreshError.value === null ? openablePreviews(summary.previews) : []
        const preview = previews[0]
        const previewAction =
          previews.length > 1
            ? h(
                NDropdown,
                {
                  trigger: 'click',
                  placement: 'bottom-end',
                  options: previews.map<DropdownOption>(item => ({
                    key: item.id,
                    label: () =>
                      h(
                        'a',
                        {
                          href: item.previewUrl,
                          target: '_blank',
                          rel: 'noopener noreferrer',
                          'aria-label': `Open ${applicationLabel(item.applicationName)} in a new tab`,
                        },
                        applicationLabel(item.applicationName),
                      ),
                  })),
                },
                {
                  default: () =>
                    h(
                      NButton,
                      {
                        size: 'small',
                        secondary: true,
                        'aria-label': `Choose a preview for root branch ${summary.rootBranch.name}`,
                      },
                      {
                        default: () => 'Open',
                        icon: () => h(Icon, { path: mdiChevronDown, size: 14, 'aria-hidden': true }),
                      },
                    ),
                },
              )
            : preview
              ? h(
                  NButton,
                  {
                    tag: 'a',
                    href: preview.previewUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    size: 'small',
                    secondary: true,
                    'aria-label': `Open ${applicationLabel(preview.applicationName)} in a new tab`,
                  },
                  {
                    default: () => 'Open',
                    icon: () => h(Icon, { path: mdiOpenInNew, size: 14, 'aria-hidden': true }),
                  },
                )
              : null
        return h(NFlex, { justify: 'flex-end', align: 'center', size: 6 }, () => [
          previewAction,
          h(
            NButton,
            {
              tag: 'a',
              href: props.detailHref(summary.capsule.capsuleId),
              size: 'small',
              ghost: true,
              'aria-label': `View capsule with root branch ${summary.rootBranch.name}`,
              onClick: (event: MouseEvent) => viewDetails(event, summary.capsule.capsuleId),
            },
            () => 'Details',
          ),
        ])
      },
    },
  ])

  function rowKey(summary: CapsuleSummary): string {
    return summary.capsule.capsuleId
  }

  function updateExpandedCapsuleIds(keys: Array<string | number>): void {
    const latestKey = keys[keys.length - 1]
    expandedCapsuleIds.value = latestKey === undefined ? [] : [String(latestKey)]
  }

  function renderExpandIcon({ expanded }: { expanded: boolean }) {
    return h(
      NButton,
      {
        size: 'tiny',
        quaternary: true,
        class: 'capsule-expand',
        'aria-label': expanded ? 'Close capsule peek' : 'Open capsule peek',
        'aria-expanded': expanded,
        onMousedown: (event: MouseEvent) => event.stopPropagation(),
      },
      {
        icon: () =>
          h(Icon, {
            path: expanded ? mdiChevronDown : mdiChevronRight,
            size: 16,
            'aria-hidden': true,
          }),
      },
    )
  }

  function viewDetails(event: MouseEvent, capsuleId: string): void {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return
    }
    event.preventDefault()
    emit('view-capsule', capsuleId)
  }
</script>

<style scoped>
  .capsule-table {
    min-width: 0;
  }

  .capsule-table :deep(.n-data-table-expand-trigger) {
    width: 24px;
    height: 24px;
    vertical-align: middle;
  }

  .capsule-table :deep(.capsule-expand) {
    width: 24px;
    height: 24px;
    padding: 0;
  }

  .capsule-table :deep(.capsule-name) {
    overflow-wrap: anywhere;
  }

  .capsule-table :deep(.runtime-dot) {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
    background-color: currentColor;
    opacity: 0.45;
  }

  .capsule-table :deep(.runtime-dot[data-tone='success']) {
    background-color: var(--qiln-telemetry-healthy);
    opacity: 1;
  }

  .capsule-table :deep(.runtime-dot[data-tone='info']) {
    background-color: var(--qiln-telemetry-cool);
    opacity: 1;
  }

  .capsule-table :deep(.runtime-dot[data-tone='warning']) {
    background-color: var(--qiln-telemetry-elevated);
    opacity: 1;
  }

  .capsule-table :deep(.runtime-dot[data-tone='error']) {
    background-color: var(--qiln-telemetry-critical);
    opacity: 1;
  }
</style>
