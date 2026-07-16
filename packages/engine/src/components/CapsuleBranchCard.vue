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
          :disabled="branch.status !== 'offline'"
          :loading="branch.status === 'starting'"
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
          :disabled="branch.status !== 'online'"
          :loading="branch.status === 'stopping'"
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
  import { computed } from 'vue'
  import { NButton, NButtonGroup, NCard, NFlex, NTag, NText, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { mdiCpu64Bit, mdiMemory, mdiPlay, mdiStop } from '@mdi/js'
  import { useCapsuleContext } from '../composables/useCapsules'
  import { Icon } from './Icon'
  import type { CapsuleBranchSummary } from '../types'

  const props = defineProps<{
    branch: CapsuleBranchSummary
  }>()

  const message = useMessage()
  const { startBranch, stopBranch } = useCapsuleContext()
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

  async function handleStart(): Promise<void> {
    try {
      await startBranch({
        capsuleId: props.branch.capsuleId,
        name: props.branch.name,
      })
      message.success('Capsule branch started.')
    } catch (error: unknown) {
      message.error(isTRPCClientError(error) ? error.message : 'Failed to start capsule branch.')
    }
  }

  async function handleStop(): Promise<void> {
    try {
      await stopBranch({
        capsuleId: props.branch.capsuleId,
        name: props.branch.name,
      })
      message.success('Capsule branch stopped.')
    } catch (error: unknown) {
      message.error(isTRPCClientError(error) ? error.message : 'Failed to stop capsule branch.')
    }
  }
</script>
