<template>
  <div class="capsule-detail">
    <header class="detail-header">
      <div>
        <h1 class="page-title">Capsule</h1>
        <n-text depth="3">
          {{ detail.branch.isRootBranch ? 'Root branch' : 'Selected branch' }}:
          <strong>{{ detail.branch.name }}</strong>
        </n-text>
        <n-text v-if="!detail.branch.isRootBranch" depth="3" class="root-identity">
          Root branch: {{ detail.rootBranch.name }}
        </n-text>
      </div>
      <code class="capsule-id" :title="detail.capsule.capsuleId">
        {{ shortId(detail.capsule.capsuleId) }}
      </code>
    </header>

    <dl class="state-strip">
      <div class="state-item">
        <dt>Capsule lifecycle</dt>
        <dd>
          <n-tag size="small" :bordered="false" :type="lifecycle.tone">{{ lifecycle.label }}</n-tag>
          <n-tag v-if="detail.capsule.archivedAt !== null" size="small" :bordered="false">Archived</n-tag>
        </dd>
      </div>
      <div class="state-item">
        <dt>Selected branch runtime</dt>
        <dd>
          <n-tag size="small" :bordered="false" :type="runtime.tone">{{ runtime.label }}</n-tag>
        </dd>
      </div>
      <div class="state-item">
        <dt>Preview</dt>
        <dd>
          <n-text v-if="detail.previews === null" depth="3">Evidence unavailable</n-text>
          <n-text v-else-if="detail.previews.length === 0" depth="3">No preview records</n-text>
          <template v-else>
            <n-tag
              v-for="preview in detail.previews"
              :key="preview.id"
              size="small"
              :bordered="false"
              :type="previewStates[preview.status].tone">
              {{ preview.applicationName }} · {{ previewStates[preview.status].label }}
            </n-tag>
          </template>
        </dd>
      </div>
      <div class="state-item">
        <dt>Current operation</dt>
        <dd>
          <n-text v-if="detail.currentOperation === null" depth="3">None</n-text>
          <template v-else>
            <span>{{ operationLabels[detail.currentOperation.type] }}</span>
            <n-tag size="small" :bordered="false" :type="operationStates[detail.currentOperation.status].tone">
              {{ operationStates[detail.currentOperation.status].label }}
            </n-tag>
          </template>
        </dd>
      </div>
    </dl>

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

    <section
      v-if="detail.currentOperation !== null"
      class="operation-banner"
      role="status"
      aria-live="polite"
      aria-atomic="true">
      <n-spin :size="18" />
      <div class="operation-content">
        <strong>
          {{ operationLabels[detail.currentOperation.type] }} ·
          {{ operationStates[detail.currentOperation.status].label }}
        </strong>
        <n-text depth="3" class="supporting-text">
          Capsule-wide operation; it may target a different branch. Runtime and preview state are shown separately.
        </n-text>
        <n-text depth="3" class="supporting-text">
          Accepted {{ formatTimestamp(detail.currentOperation.acceptedAt) }}
          <template v-if="detail.currentOperation.executionStartedAt !== null">
            · Execution started {{ formatTimestamp(detail.currentOperation.executionStartedAt) }}
          </template>
        </n-text>
      </div>
    </section>

    <div class="control-grid">
      <n-card embedded size="small" class="detail-panel">
        <template #header><h2 class="panel-title">Runtime</h2></template>
        <n-flex vertical :size="18">
          <n-descriptions :column="1" label-placement="left" size="small">
            <n-descriptions-item label="Branch">{{ detail.branch.name }}</n-descriptions-item>
            <n-descriptions-item label="Runtime state">
              <n-tag size="small" :bordered="false" :type="runtime.tone">{{ runtime.label }}</n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="Recorded runtime IP">
              <code v-if="detail.branch.runtimeIp !== null">{{ detail.branch.runtimeIp }}</code>
              <n-text v-else depth="3">Not recorded</n-text>
            </n-descriptions-item>
          </n-descriptions>
          <n-text depth="3" class="supporting-text">
            Runtime state is recorded by Qiln. It does not by itself prove application, GPU, or storage health.
          </n-text>
          <n-flex :size="8">
            <n-button
              type="primary"
              size="small"
              :disabled="!canStart"
              :loading="submitting === 'start'"
              @click="submit('start')">
              <template #icon><icon :path="mdiPlay" :size="16" /></template>
              Start branch
            </n-button>
            <n-popconfirm
              :disabled="!canStop"
              positive-text="Stop branch"
              negative-text="Keep running"
              :positive-button-props="{ type: 'warning' }"
              @positive-click="submit('stop')">
              <template #trigger>
                <n-button secondary type="warning" size="small" :disabled="!canStop" :loading="submitting === 'stop'">
                  <template #icon><icon :path="mdiStop" :size="16" /></template>
                  Stop branch
                </n-button>
              </template>
              <div class="stop-confirmation">
                Stop branch “{{ detail.branch.name }}”? Qiln revokes branch-scoped SSH access and withdraws previews
                before stopping the runtime. Active SSH sessions will disconnect. External side effects are not
                reversed.
              </div>
            </n-popconfirm>
          </n-flex>
          <n-text v-if="controlHint" depth="3" class="supporting-text">{{ controlHint }}</n-text>
        </n-flex>
      </n-card>

      <n-card embedded size="small" class="detail-panel">
        <template #header><h2 class="panel-title">Preview</h2></template>
        <n-alert v-if="detail.previews === null" type="warning" :show-icon="false">
          Historical application evidence is unavailable. Preview state cannot be presented from this evidence.
        </n-alert>
        <n-empty
          v-else-if="detail.previews.length === 0"
          description="No preview records for this branch."
          class="panel-empty" />
        <div v-else class="preview-list">
          <section v-for="preview in detail.previews" :key="preview.id" class="preview-item">
            <n-flex justify="space-between" align="center" :size="8">
              <h3 class="application-title">{{ applicationLabel(preview.applicationName) }}</h3>
              <n-tag size="small" :bordered="false" :type="previewStates[preview.status].tone">
                {{ previewStates[preview.status].label }}
              </n-tag>
            </n-flex>
            <n-text depth="3" class="supporting-text">{{ previewDescriptions[preview.status] }}</n-text>
            <n-text depth="3" class="supporting-text">
              Last verified:
              {{ preview.verifiedAt === null ? 'Not recorded' : formatTimestamp(preview.verifiedAt) }}
            </n-text>
            <template v-if="preview.status === 'active' && preview.previewUrl !== null && refreshError === null">
              <code class="preview-url">{{ preview.previewUrl }}</code>
              <div>
                <n-button
                  tag="a"
                  :href="preview.previewUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  type="primary"
                  secondary
                  size="small"
                  :aria-label="`Open ${applicationLabel(preview.applicationName)} in a new tab`">
                  <template #icon><icon :path="mdiOpenInNew" :size="16" /></template>
                  Open {{ applicationLabel(preview.applicationName) }}
                </n-button>
              </div>
            </template>
            <n-text v-else-if="preview.status === 'active'" depth="3" class="supporting-text">
              The preview link is currently unavailable for this branch.
            </n-text>
          </section>
        </div>
      </n-card>
    </div>

    <n-card embedded size="small" class="detail-panel">
      <template #header><h2 class="panel-title">Capsule anatomy</h2></template>
      <n-alert v-if="!detail.manifest.available" type="info" :show-icon="false">
        {{ manifestUnavailableMessage }}
      </n-alert>
      <template v-else>
        <n-text depth="3" class="panel-introduction">
          Historical configuration pinned to the selected branch—not a live infrastructure inventory.
        </n-text>
        <n-descriptions :column="1" label-placement="left" size="small">
          <n-descriptions-item label="Blueprint">
            {{ detail.manifest.manifest.blueprint.name }}
          </n-descriptions-item>
          <n-descriptions-item label="Blueprint digest">
            <code class="fingerprint">{{ detail.manifest.manifest.blueprint.digest }}</code>
          </n-descriptions-item>
          <n-descriptions-item label="Rootfs image fingerprint">
            <code class="fingerprint">{{ detail.manifest.manifest.rootfsImageFingerprint }}</code>
          </n-descriptions-item>
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
          <n-descriptions-item label="Declared applications">
            {{ detail.manifest.manifest.applicationCount }}
          </n-descriptions-item>
        </n-descriptions>
        <n-text depth="3" class="panel-note">
          GPU declarations do not prove allocation, exclusivity, availability, or health.
        </n-text>
      </template>
    </n-card>

    <n-card embedded size="small" class="detail-panel">
      <template #header><h2 class="panel-title">Declared storage boundaries</h2></template>
      <n-alert v-if="!detail.manifest.available" type="info" :show-icon="false">
        Storage declarations are unavailable because the selected branch’s historical manifest is unavailable.
      </n-alert>
      <template v-else>
        <n-text depth="3" class="panel-introduction">
          Paths are inside the capsule. These declarations describe storage and versioning boundaries, not live mount
          health.
        </n-text>
        <n-data-table
          size="small"
          :bordered="false"
          :columns="storageColumns"
          :data="detail.manifest.manifest.storageBoundaries"
          :row-key="storageKey"
          :scroll-x="760">
          <template #empty>
            <n-empty description="No storage boundaries declared in the pinned manifest." />
          </template>
        </n-data-table>
        <n-text depth="3" class="panel-note">
          Read-only baseline clones are not live shared vaults. Unversioned storage is excluded from snapshot
          restoration; external bind mounts do not preserve historical contents.
        </n-text>
      </template>
    </n-card>
  </div>
</template>

<script setup lang="ts">
  import { computed, h, ref } from 'vue'
  import {
    NAlert,
    NButton,
    NCard,
    NDataTable,
    NDescriptions,
    NDescriptionsItem,
    NEmpty,
    NFlex,
    NPopconfirm,
    NSpin,
    NTag,
    NText,
    useMessage,
    type DataTableColumns,
  } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { mdiOpenInNew, mdiPlay, mdiStop } from '@mdi/js'
  import type { CapsuleDetail, CapsuleOperationIdempotencyKey, CapsuleStorageBoundary } from '@qiln/core/client'
  import { useCapsuleContext } from '../../composables/useCapsules'
  import { createIdempotencyKey } from '../../utils/idempotency'
  import { Icon } from '../Icon'
  import {
    branchStates,
    formatTimestamp,
    lifecycleStates,
    operationLabels,
    operationStates,
    previewDescriptions,
    previewStates,
    shortId,
  } from './state'

  type RuntimeAction = 'start' | 'stop'

  interface PendingIntent {
    action: RuntimeAction
    capsuleId: string
    branchId: string
    idempotencyKey: CapsuleOperationIdempotencyKey
  }

  defineOptions({
    name: 'CapsuleDetailDashboard',
  })

  const props = defineProps<{
    detail: CapsuleDetail
  }>()

  const message = useMessage()
  const capsules = useCapsuleContext()
  const { refreshing, refreshError } = capsules
  const submitting = ref<RuntimeAction | null>(null)
  const pendingIntent = ref<PendingIntent | null>(null)

  const lifecycle = computed(() => lifecycleStates[props.detail.capsule.lifecycleStatus])
  const runtime = computed(() => branchStates[props.detail.branch.status])
  const controlsAvailable = computed(() => {
    const { capsule, currentOperation } = props.detail
    return (
      capsule.lifecycleStatus === 'active' &&
      capsule.archivedAt === null &&
      capsule.destroyedAt === null &&
      currentOperation === null &&
      submitting.value === null &&
      !refreshing.value &&
      refreshError.value === null
    )
  })
  const canStart = computed(() => controlsAvailable.value && props.detail.branch.status === 'offline')
  const canStop = computed(() => controlsAvailable.value && props.detail.branch.status === 'online')

  const controlHint = computed(() => {
    if (submitting.value !== null) {
      return 'Submitting the branch operation. Acceptance does not mean execution has completed.'
    }
    if (refreshError.value !== null) {
      return 'Refresh capsule state before submitting another operation.'
    }
    if (props.detail.currentOperation !== null) {
      return 'Runtime controls are unavailable while a capsule operation is in progress.'
    }
    if (props.detail.capsule.archivedAt !== null) {
      return 'Runtime controls are unavailable while the capsule is archived.'
    }
    if (props.detail.capsule.lifecycleStatus !== 'active') {
      return 'Runtime controls require an active capsule.'
    }
    if (refreshing.value) {
      return 'Refreshing capsule state.'
    }
    if (props.detail.branch.status !== 'online' && props.detail.branch.status !== 'offline') {
      return 'Runtime controls are unavailable in the recorded branch state.'
    }
    return ''
  })

  const manifestUnavailableMessage = computed(() => {
    const { manifest } = props.detail
    if (manifest.available) {
      return ''
    }
    return manifest.reason === 'creation_not_completed'
      ? 'Capsule creation has not completed. The historical manifest is not yet available.'
      : 'Historical branch evidence is unavailable. Qiln cannot present a verified manifest for this branch.'
  })

  const storageColumns: DataTableColumns<CapsuleStorageBoundary> = [
    {
      title: 'Name',
      key: 'name',
      width: 150,
    },
    {
      title: 'Boundary',
      key: 'kind',
      width: 150,
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
      width: 140,
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
      width: 110,
      render: boundary => (boundary.readonly ? 'Read-only' : 'Writable'),
    },
    {
      title: 'Mount path',
      key: 'mountPath',
      width: 250,
      render: boundary => h('code', { style: { overflowWrap: 'anywhere' } }, boundary.mountPath),
    },
  ]

  function storageKey(boundary: CapsuleStorageBoundary): string {
    return boundary.name
  }

  function applicationLabel(name: string): string {
    return name.toLowerCase() === 'comfyui' ? 'ComfyUI' : name
  }

  function resolveIntent(action: RuntimeAction): PendingIntent | null {
    const capsuleId = props.detail.capsule.capsuleId
    const branchId = props.detail.branch.id
    const pending = pendingIntent.value
    if (pending?.action === action && pending.capsuleId === capsuleId && pending.branchId === branchId) {
      return pending
    }
    const idempotencyKey = createIdempotencyKey()
    if (idempotencyKey === null) {
      return null
    }
    const intent: PendingIntent = {
      action,
      capsuleId,
      branchId,
      idempotencyKey,
    }
    pendingIntent.value = intent
    return intent
  }

  async function submit(action: RuntimeAction): Promise<void> {
    if (action === 'start' ? !canStart.value : !canStop.value) {
      return
    }
    const intent = resolveIntent(action)
    if (intent === null) {
      message.error('Unable to generate an operation key. Use a modern browser in a secure context.')
      return
    }
    submitting.value = action
    try {
      const input = {
        capsuleId: intent.capsuleId,
        branchId: intent.branchId,
        idempotencyKey: intent.idempotencyKey,
      }
      const receipt = action === 'start' ? await capsules.startBranch(input) : await capsules.stopBranch(input)
      pendingIntent.value = null
      const label = operationLabels[receipt.operationType]
      if (receipt.operationStatus === 'failed' || receipt.operationStatus === 'cleanup_required') {
        message.warning(`${label}: ${operationStates[receipt.operationStatus].label.toLowerCase()}.`)
      } else if (receipt.operationStatus === 'completed') {
        message.success(`${label} completed.`)
      } else {
        message.success(`${label} ${receipt.replayed ? 'already accepted' : 'accepted'}.`)
      }
    } catch (error: unknown) {
      message.error(
        isTRPCClientError(error)
          ? error.message
          : 'The branch submission could not be confirmed. Refresh state before retrying.',
      )
    } finally {
      submitting.value = null
    }
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
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 1440px;
    min-width: 0;
  }

  .detail-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }

  .page-title {
    margin: 0 0 4px;
    font-size: 24px;
    font-weight: 600;
  }

  .root-identity {
    display: block;
    margin-top: 4px;
    font-size: 12px;
  }

  .capsule-id {
    padding-top: 6px;
    font-size: 12px;
    opacity: 0.55;
  }

  .state-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin: 0;
    padding: 16px;
    border: 1px solid var(--qiln-surface-border-strong, rgba(255, 255, 255, 0.08));
    border-radius: 6px;
    background: var(--qiln-surface-highlight, rgba(255, 255, 255, 0.025));
  }

  .state-item dt {
    margin-bottom: 8px;
    font-size: 12px;
    opacity: 0.6;
  }

  .state-item dd {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    font-size: 13px;
  }

  .operation-banner {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--qiln-surface-border-strong, rgba(255, 255, 255, 0.08));
    border-inline-start: 3px solid var(--qiln-telemetry-cool, #8b5cf6);
    border-radius: 6px;
    background: var(--qiln-surface-highlight, rgba(255, 255, 255, 0.025));
  }

  .operation-content {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .control-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }

  .detail-panel {
    min-width: 0;
  }

  .panel-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .supporting-text,
  .panel-introduction,
  .panel-note {
    display: block;
    font-size: 12px;
    line-height: 1.6;
  }

  .panel-introduction {
    margin-bottom: 16px;
  }

  .panel-note {
    margin-top: 16px;
  }

  .preview-list,
  .preview-item {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .preview-item + .preview-item {
    padding-top: 16px;
    border-top: 1px solid var(--qiln-surface-border-strong, rgba(255, 255, 255, 0.08));
  }

  .application-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .fingerprint,
  .preview-url {
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .panel-empty {
    padding: 20px 0;
  }

  .stop-confirmation {
    max-width: 320px;
  }

  @media (min-width: 960px) {
    .control-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
</style>
