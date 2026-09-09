<!-- packages/engine/src/components/CapsuleBranchCard.vue -->
<template>
  <n-card bordered embedded size="small" class="capsule-branch-card">
    <template #header>
      <n-flex :size="8" align="center">
        <n-text style="font-weight: 600; letter-spacing: 0.05em">
          {{ branch.name }}
        </n-text>
        <n-tag v-if="branch.isRootBranch" size="small" :bordered="false">Root</n-tag>
      </n-flex>
    </template>
    <template #header-extra>
      <n-tag :type="statusType" size="small" round :bordered="false">
        {{ branch.status.toUpperCase() }}
      </n-tag>
    </template>
    <n-flex vertical :size="12">
      <n-flex :size="16" align="center">
        <n-flex :size="6" align="center">
          <icon :path="mdiCpu64Bit" :size="16" style="opacity: 0.5" />
          <n-text depth="2">{{ branch.cpu }} CPU Limit</n-text>
        </n-flex>
        <n-flex :size="6" align="center">
          <icon :path="mdiMemory" :size="16" style="opacity: 0.5" />
          <n-text depth="2">{{ branch.memory }}</n-text>
        </n-flex>
      </n-flex>
      <n-text depth="3" style="font-size: 12px">Blueprint: {{ branch.blueprintName }}</n-text>
      <n-text v-if="branch.runtimeIp" depth="3" style="font-size: 12px">Runtime IP: {{ branch.runtimeIp }}</n-text>
    </n-flex>
    <template #action>
      <n-button-group>
        <n-button
          size="small"
          type="success"
          secondary
          :disabled="branch.status !== 'offline' || submittingAction !== null"
          :loading="submittingAction === 'start'"
          @click="handleStart">
          <template #icon>
            <icon :path="mdiPlay" :size="16" />
          </template>
          Start
        </n-button>
        <n-button
          size="small"
          type="warning"
          secondary
          :disabled="branch.status !== 'online' || submittingAction !== null"
          :loading="submittingAction === 'stop'"
          @click="handleStop">
          <template #icon>
            <icon :path="mdiStop" :size="16" />
          </template>
          Stop
        </n-button>
      </n-button-group>
    </template>
  </n-card>
</template>

<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { NButton, NButtonGroup, NCard, NFlex, NTag, NText, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { mdiCpu64Bit, mdiMemory, mdiPlay, mdiStop } from '@mdi/js'
  import { CapsuleOperationIdempotencyKeySchema, type CapsuleOperationIdempotencyKey } from '@qiln/core/client'
  import { useCapsuleContext } from '../composables/useCapsules'
  import { Icon } from './Icon'
  import type { CapsuleBranchSummary } from '../types'

  type BranchMutationAction = 'start' | 'stop'

  interface PendingBranchMutation {
    action: BranchMutationAction
    idempotencyKey: CapsuleOperationIdempotencyKey
  }

  const props = defineProps<{
    branch: CapsuleBranchSummary
  }>()

  const message = useMessage()
  const { startBranch, stopBranch } = useCapsuleContext()
  const pendingMutation = ref<PendingBranchMutation | null>(null)
  const submittingAction = ref<BranchMutationAction | null>(null)
  const statusType = computed(() => {
    switch (props.branch.status) {
      case 'online':
        return 'success'
      case 'provisioning':
      case 'starting':
      case 'stopping':
      case 'destroying':
        return 'warning'
      case 'error':
      case 'cleanup_required':
        return 'error'
      default:
        return 'default'
    }
  })

  function generateOperationIdempotencyKey(): CapsuleOperationIdempotencyKey | null {
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      return null
    }
    const parsed = CapsuleOperationIdempotencyKeySchema.safeParse(globalThis.crypto.randomUUID())
    return parsed.success ? parsed.data : null
  }

  function resolveOperationIdempotencyKey(action: BranchMutationAction): CapsuleOperationIdempotencyKey | null {
    if (pendingMutation.value?.action === action) {
      return pendingMutation.value.idempotencyKey
    }
    const idempotencyKey = generateOperationIdempotencyKey()
    if (!idempotencyKey) {
      return null
    }
    pendingMutation.value = {
      action,
      idempotencyKey,
    }
    return idempotencyKey
  }

  async function handleStart(): Promise<void> {
    await submitBranchMutation('start')
  }

  async function handleStop(): Promise<void> {
    await submitBranchMutation('stop')
  }

  async function submitBranchMutation(action: BranchMutationAction): Promise<void> {
    if (submittingAction.value !== null) {
      return
    }
    const idempotencyKey = resolveOperationIdempotencyKey(action)
    if (!idempotencyKey) {
      message.error('Failed to generate a capsule operation idempotency key. Please retry in a modern browser.')
      return
    }
    submittingAction.value = action
    try {
      const input = {
        capsuleId: props.branch.capsuleId,
        branchId: props.branch.id,
        idempotencyKey,
      }
      if (action === 'start') {
        await startBranch(input)
      } else {
        await stopBranch(input)
      }
      pendingMutation.value = null
      message.success(`Capsule branch ${action} accepted.`)
    } catch (error: unknown) {
      message.error(isTRPCClientError(error) ? error.message : `Failed to submit capsule branch ${action}.`)
    } finally {
      submittingAction.value = null
    }
  }
</script>
