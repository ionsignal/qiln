<template>
  <n-flex vertical :size="8">
    <n-flex v-if="visibleAction !== null" justify="end">
      <n-button-group size="tiny">
        <n-tooltip v-if="visibleAction === 'start'">
          <template #trigger>
            <n-button
              type="primary"
              ghost
              :disabled="!canStart"
              :loading="submitting === 'start'"
              aria-label="Start branch"
              @click="submit('start')">
              <template #icon><icon :path="mdiPlay" :size="14" aria-hidden="true" /></template>
            </n-button>
          </template>
          Start branch
        </n-tooltip>
        <n-popconfirm
          v-else
          :disabled="!canStop"
          positive-text="Stop branch"
          negative-text="Keep running"
          :positive-button-props="{ type: 'warning', loading: submitting === 'stop' }"
          @positive-click="submit('stop')">
          <template #trigger>
            <n-tooltip>
              <template #trigger>
                <n-button
                  type="warning"
                  ghost
                  :disabled="!canStop"
                  :loading="submitting === 'stop'"
                  aria-label="Stop branch">
                  <template #icon><icon :path="mdiStop" :size="14" aria-hidden="true" /></template>
                </n-button>
              </template>
              Stop branch
            </n-tooltip>
          </template>
          <div class="stop-confirmation">
            Stop branch “{{ branch.name }}”? Qiln revokes branch-scoped SSH access and withdraws previews before
            stopping the runtime. Active SSH sessions will disconnect. External side effects are not reversed.
          </div>
        </n-popconfirm>
        <n-button ghost disabled aria-label="Fork branch">
          <template #icon><icon :path="mdiSourceFork" :size="14" aria-hidden="true" /></template>
        </n-button>
        <n-button ghost disabled :aria-label="rootBranchActionLabel">
          <template #icon><icon :path="mdiFlag" :size="14" aria-hidden="true" /></template>
        </n-button>
      </n-button-group>
    </n-flex>
    <n-text v-if="controlHint" depth="3" role="status" aria-live="polite">
      {{ controlHint }}
    </n-text>
  </n-flex>
</template>

<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { NButton, NButtonGroup, NFlex, NPopconfirm, NText, NTooltip, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { mdiPlay, mdiFlag, mdiSourceFork, mdiStop } from '@mdi/js'
  import type {
    CapsuleBranchRuntime,
    CapsuleCurrentOperation,
    CapsuleLifecycleState,
    CapsuleOperationIdempotencyKey,
  } from '@qiln/core/client'
  import { useCapsuleContext } from '../../composables/useCapsules'
  import { createIdempotencyKey } from '../../utils/idempotency'
  import { Icon } from '../Icon'
  import { branchStates, operationLabels, operationStates } from './state'

  type RuntimeAction = 'start' | 'stop'

  interface PendingIntent {
    action: RuntimeAction
    capsuleId: string
    branchId: string
    idempotencyKey: CapsuleOperationIdempotencyKey
  }

  const props = withDefaults(
    defineProps<{
      capsule: CapsuleLifecycleState
      branch: CapsuleBranchRuntime
      currentOperation: CapsuleCurrentOperation | null
    }>(),
    {},
  )

  const message = useMessage()
  const capsules = useCapsuleContext()
  const { refreshing, refreshError } = capsules
  const submitting = ref<RuntimeAction | null>(null)
  const pendingIntent = ref<PendingIntent | null>(null)

  const controlsAvailable = computed(() => {
    const { capsule, currentOperation } = props
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

  const canStart = computed(() => controlsAvailable.value && props.branch.status === 'offline')
  const canStop = computed(() => controlsAvailable.value && props.branch.status === 'online')
  const visibleAction = computed<RuntimeAction | null>(() => {
    if (submitting.value !== null) {
      return submitting.value
    }
    if (props.branch.status === 'offline') {
      return 'start'
    }
    return props.branch.status === 'online' ? 'stop' : null
  })

  const rootBranchActionLabel = computed(() =>
    props.branch.isRootBranch ? 'Current root branch' : 'Set as root branch',
  )

  const controlHint = computed(() => {
    if (submitting.value !== null) {
      return 'Submitting. Acceptance does not mean execution has completed.'
    }
    if (refreshError.value !== null) {
      return 'Refresh capsule state before submitting another operation.'
    }
    if (props.currentOperation !== null) {
      return 'Controls unavailable during a capsule operation.'
    }
    if (props.capsule.archivedAt !== null) {
      return 'Controls unavailable while the capsule is archived.'
    }
    if (props.capsule.lifecycleStatus !== 'active') {
      return 'Controls require an active capsule.'
    }
    if (refreshing.value) {
      return 'Refreshing capsule state.'
    }
    if (props.branch.status !== 'online' && props.branch.status !== 'offline') {
      return `Controls unavailable: ${branchStates[props.branch.status].label.toLowerCase()}.`
    }
    return ''
  })

  function resolveIntent(action: RuntimeAction): PendingIntent | null {
    const capsuleId = props.capsule.capsuleId
    const branchId = props.branch.id
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

  async function submit(action: RuntimeAction): Promise<boolean> {
    if (action === 'start' ? !canStart.value : !canStop.value) {
      return false
    }
    const intent = resolveIntent(action)
    if (intent === null) {
      message.error('Unable to generate an operation key. Use a modern browser in a secure context.')
      return false
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
      return true
    } catch (error: unknown) {
      message.error(
        isTRPCClientError(error)
          ? error.message
          : 'The branch submission could not be confirmed. Refresh state before retrying.',
      )
      return false
    } finally {
      submitting.value = null
    }
  }
</script>

<style scoped>
  .stop-confirmation {
    max-width: 320px;
  }
</style>
