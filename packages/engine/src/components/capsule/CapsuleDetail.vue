<template>
  <n-flex vertical :size="20" class="capsule-detail">
    <header>
      <h1 class="page-title">Capsule details</h1>
      <n-text depth="3">
        {{ detail.branch.isRootBranch ? 'Root branch' : 'Selected branch' }}:
        <strong>{{ detail.branch.name }}</strong>
      </n-text>
      <n-text v-if="!detail.branch.isRootBranch" depth="3" class="root-identity">
        Root branch: {{ detail.rootBranch.name }}
      </n-text>
    </header>
    <n-alert v-if="refreshError !== null" type="warning" title="Displayed state may be out of date">
      <n-flex vertical :size="10">
        <span>
          Qiln could not refresh this capsule. Runtime actions and preview links are unavailable until state is
          refreshed. An accepted operation is not undone by a refresh failure.
        </span>
        <div>
          <n-button size="small" :loading="refreshing" @click="retryRefresh">Refresh state</n-button>
        </div>
      </n-flex>
    </n-alert>
    <n-flex
      v-if="detail.currentOperation !== null"
      align="center"
      :size="12"
      role="status"
      aria-live="polite"
      aria-atomic="true">
      <n-spin :size="18" />
      <n-flex vertical :size="5">
        <strong>
          {{ operationLabels[detail.currentOperation.type] }} ·
          {{ operationStates[detail.currentOperation.status].label }}
        </strong>
        <n-text depth="3">
          Capsule-wide operation; it may target a different branch. Runtime and preview state are shown separately.
        </n-text>
        <n-text depth="3">
          Accepted {{ formatTimestamp(detail.currentOperation.acceptedAt) }}
          <template v-if="detail.currentOperation.executionStartedAt !== null">
            · Execution started {{ formatTimestamp(detail.currentOperation.executionStartedAt) }}
          </template>
        </n-text>
      </n-flex>
    </n-flex>
    <n-card bordered size="small" class="inspection">
      <template #header>
        <n-flex justify="space-between" align="center" :size="12">
          <h2 class="panel-title">Inspection</h2>
          <n-flex align="center" :size="6">
            <n-tag size="small" :bordered="false" :type="lifecycle.tone" :aria-label="`Capsule: ${lifecycle.label}`">
              {{ lifecycle.label }}
            </n-tag>
            <n-tag v-if="detail.capsule.archivedAt !== null" size="small" :bordered="false">Archived</n-tag>
          </n-flex>
        </n-flex>
      </template>
      <!-- Preserve mounted runtime controls and their pending intent when a section closes. -->
      <n-collapse :default-expanded-names="['runtime', 'applications']" display-directive="show">
        <n-collapse-item name="runtime">
          <template #header="{ collapsed }">
            <button type="button" class="section-toggle" :aria-expanded="!collapsed">
              <icon :path="mdiConsoleLine" :size="16" aria-hidden="true" />
              Runtime
            </button>
          </template>
          <template #header-extra>
            <n-tag size="small" :bordered="false" :type="runtime.tone">{{ runtime.label }}</n-tag>
          </template>
          <n-flex vertical :size="12">
            <n-descriptions :column="1" label-placement="left" size="small">
              <n-descriptions-item label="Selected branch">{{ detail.branch.name }}</n-descriptions-item>
              <n-descriptions-item label="Recorded runtime IP">
                <code v-if="detail.branch.runtimeIp !== null">{{ detail.branch.runtimeIp }}</code>
                <n-text v-else depth="3">Not recorded</n-text>
              </n-descriptions-item>
              <template v-if="detail.manifest.available">
                <n-descriptions-item label="CPU limit">{{ detail.manifest.manifest.cpu }}</n-descriptions-item>
                <n-descriptions-item label="Memory limit">{{ detail.manifest.manifest.memory }}</n-descriptions-item>
                <n-descriptions-item label="Configured GPU runtime">
                  <template v-if="detail.manifest.manifest.gpu.configured">
                    {{ detail.manifest.manifest.gpu.deviceCount }}
                    {{
                      detail.manifest.manifest.gpu.deviceCount === 1
                        ? 'GPU device entry declared'
                        : 'GPU device entries declared'
                    }}
                  </template>
                  <template v-else>No GPU devices declared</template>
                </n-descriptions-item>
              </template>
            </n-descriptions>
            <n-text v-if="!detail.manifest.available" depth="3">
              CPU, memory, and GPU declarations are unavailable. {{ manifestUnavailableMessage }}
            </n-text>
            <capsule-controls
              :capsule="detail.capsule"
              :branch="detail.branch"
              :current-operation="detail.currentOperation" />
            <n-text depth="3">
              Recorded runtime state and pinned configuration do not prove application, GPU, or storage health. GPU
              declarations do not prove allocation, exclusivity, or availability.
            </n-text>
          </n-flex>
        </n-collapse-item>

        <n-collapse-item name="applications">
          <template #header="{ collapsed }">
            <button type="button" class="section-toggle" :aria-expanded="!collapsed">
              <icon :path="mdiOpenInNew" :size="16" aria-hidden="true" />
              Applications
            </button>
          </template>
          <template #header-extra>
            <n-text depth="3">{{ applicationsSummary }}</n-text>
          </template>
          <n-alert v-if="detail.previews === null" type="warning" :show-icon="false">
            Historical application evidence is unavailable. Preview state cannot be presented from this evidence.
          </n-alert>
          <n-empty v-else-if="detail.previews.length === 0" description="No preview records for this branch." />
          <n-data-table
            v-else
            size="small"
            :bordered="false"
            :columns="applicationColumns"
            :data="detail.previews"
            :row-key="previewKey" />
        </n-collapse-item>
        <n-collapse-item name="storage">
          <template #header="{ collapsed }">
            <button type="button" class="section-toggle" :aria-expanded="!collapsed">
              <icon :path="mdiFolderOutline" :size="16" aria-hidden="true" />
              Storage
            </button>
          </template>
          <template #header-extra>
            <n-text depth="3">
              {{
                detail.manifest.available
                  ? `${detail.manifest.manifest.storageBoundaries.length} declared`
                  : 'Unavailable'
              }}
            </n-text>
          </template>
          <n-alert v-if="!detail.manifest.available" type="info" :show-icon="false">
            Storage declarations are unavailable because the selected branch’s historical manifest is unavailable.
          </n-alert>
          <n-flex v-else vertical :size="12">
            <n-text depth="3">
              Paths are inside the capsule. These declarations describe storage and versioning boundaries, not live
              mount health.
            </n-text>
            <n-data-table
              size="small"
              :bordered="false"
              :columns="storageColumns"
              :data="detail.manifest.manifest.storageBoundaries"
              :row-key="storageKey">
              <template #empty>
                <n-empty description="No storage boundaries declared in the pinned manifest." />
              </template>
            </n-data-table>
            <n-text depth="3">
              Read-only baseline clones are not live shared vaults. Unversioned storage is excluded from snapshot
              restoration; external bind mounts do not preserve historical contents.
            </n-text>
          </n-flex>
        </n-collapse-item>
        <n-collapse-item name="configuration">
          <template #header="{ collapsed }">
            <button type="button" class="section-toggle" :aria-expanded="!collapsed">
              <icon :path="mdiCog" :size="16" aria-hidden="true" />
              Configuration
            </button>
          </template>
          <template #header-extra>
            <n-text depth="3">
              {{ detail.manifest.available ? 'Pinned manifest' : 'Unavailable' }}
            </n-text>
          </template>
          <n-alert v-if="!detail.manifest.available" type="info" :show-icon="false">
            {{ manifestUnavailableMessage }}
          </n-alert>
          <n-flex v-else vertical :size="12">
            <n-descriptions :column="1" label-placement="left" size="small">
              <n-descriptions-item label="Blueprint">
                {{ detail.manifest.manifest.blueprint.name }}
              </n-descriptions-item>
              <n-descriptions-item label="Declared applications">
                {{ detail.manifest.manifest.applicationCount }}
              </n-descriptions-item>
            </n-descriptions>
            <n-text depth="3">
              Historical configuration pinned to the selected branch—not a live infrastructure inventory.
            </n-text>
          </n-flex>
        </n-collapse-item>
      </n-collapse>
    </n-card>
  </n-flex>
</template>

<script setup lang="ts">
  import { computed, h } from 'vue'
  import {
    NAlert,
    NButton,
    NCard,
    NCollapse,
    NCollapseItem,
    NDataTable,
    NDescriptions,
    NDescriptionsItem,
    NEmpty,
    NFlex,
    NSpin,
    NTag,
    NText,
    useMessage,
    type DataTableColumns,
  } from 'naive-ui'
  import { mdiCog, mdiConsoleLine, mdiFolderOutline, mdiOpenInNew } from '@mdi/js'
  import type { CapsuleDetail, CapsulePreview, CapsuleStorageBoundary } from '@qiln/core/client'
  import { useCapsuleContext } from '../../composables/useCapsules'
  import { Icon } from '../Icon'
  import CapsuleControls from './CapsuleBranchControls.vue'
  import {
    applicationLabel,
    branchStates,
    formatTimestamp,
    lifecycleStates,
    operationLabels,
    operationStates,
    previewDescriptions,
    previewStates,
    previewSummary,
  } from './state'

  defineOptions({
    name: 'CapsuleDetailDashboard',
  })

  const props = defineProps<{
    detail: CapsuleDetail
  }>()

  const message = useMessage()
  const capsules = useCapsuleContext()
  const { refreshing, refreshError } = capsules

  const lifecycle = computed(() => lifecycleStates[props.detail.capsule.lifecycleStatus])
  const runtime = computed(() => branchStates[props.detail.branch.status])
  const applicationsSummary = computed(() => previewSummary(props.detail.previews).label)

  const manifestUnavailableMessage = computed(() => {
    const { manifest } = props.detail
    if (manifest.available) {
      return ''
    }
    return manifest.reason === 'creation_not_completed'
      ? 'Capsule creation has not completed. The historical manifest is not yet available.'
      : 'Historical branch evidence is unavailable. Qiln cannot present a verified manifest for this branch.'
  })

  const applicationColumns = computed<DataTableColumns<CapsulePreview>>(() => [
    {
      title: 'Application',
      key: 'applicationName',
      render: preview => applicationLabel(preview.applicationName),
    },
    {
      title: 'Preview',
      key: 'status',
      render: preview => {
        const state = previewStates[preview.status]
        return h(NFlex, { vertical: true, align: 'flex-start', size: 4 }, () => [
          h(NTag, { size: 'small', bordered: false, type: state.tone }, () => state.label),
          h(NText, { depth: 3 }, () => previewDescriptions[preview.status]),
        ])
      },
    },
    {
      title: 'Last verified',
      key: 'verifiedAt',
      render: preview => (preview.verifiedAt === null ? 'Not recorded' : formatTimestamp(preview.verifiedAt)),
    },
    {
      title: 'Actions',
      key: 'actions',
      align: 'right',
      render: preview => {
        if (preview.status !== 'active') {
          return null
        }
        if (preview.previewUrl === null || refreshError.value !== null) {
          return h(NText, { depth: 3 }, () => 'Link unavailable')
        }
        return h(
          NButton,
          {
            tag: 'a',
            href: preview.previewUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            secondary: true,
            size: 'small',
            'aria-label': `Open ${applicationLabel(preview.applicationName)} in a new tab`,
          },
          {
            default: () => 'Open',
            icon: () => h(Icon, { path: mdiOpenInNew, size: 16, 'aria-hidden': true }),
          },
        )
      },
    },
  ])

  const storageColumns: DataTableColumns<CapsuleStorageBoundary> = [
    {
      title: 'Name',
      key: 'name',
    },
    {
      title: 'Boundary',
      key: 'kind',
      render(boundary) {
        switch (boundary.kind) {
          case 'clone':
            return 'Baseline clone'
          case 'empty':
            return 'Managed volume'
          case 'bind':
            return 'External bind mount'
        }
      },
    },
    {
      title: 'Versioning',
      key: 'versioning',
      render(boundary) {
        const label =
          boundary.versioning === 'versioned'
            ? 'Versioned'
            : boundary.versioning === 'unversioned'
              ? 'Not versioned'
              : 'External'
        return h(
          NTag,
          {
            size: 'small',
            bordered: false,
            type: boundary.versioning === 'versioned' ? 'info' : 'default',
          },
          () => label,
        )
      },
    },
    {
      title: 'Access',
      key: 'readonly',
      render: boundary => (boundary.readonly ? 'Read-only' : 'Writable'),
    },
    {
      title: 'Mount path',
      key: 'mountPath',
      render: boundary => h('code', { class: 'storage-path' }, boundary.mountPath),
    },
  ]

  function previewKey(preview: CapsulePreview): string {
    return preview.id
  }

  function storageKey(boundary: CapsuleStorageBoundary): string {
    return boundary.name
  }

  async function retryRefresh(): Promise<void> {
    try {
      await capsules.refresh()
    } catch {
      message.error('Capsule state could not be refreshed. Please try again.')
    }
  }
</script>

<style scoped>
  .capsule-detail {
    min-width: 0;
  }

  .page-title {
    margin: 0 0 4px;
    font-size: 24px;
    font-weight: 600;
  }

  .root-identity {
    display: block;
    margin-top: 4px;
  }

  .inspection {
    min-width: 0;
  }

  .panel-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .section-toggle {
    display: flex;
    align-items: center;
    flex: 1;
    gap: 8px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: inherit;
  }

  .section-toggle:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
    border-radius: 3px;
  }

  .inspection :deep(.storage-path) {
    overflow-wrap: anywhere;
  }
</style>
