<template>
  <n-card bordered embedded size="small" class="capsule-branch-card">
    <template #header>
      <n-text style="font-weight: 600; letter-spacing: 0.05em">{{ branch.name }}</n-text>
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
      <n-text depth="3" style="font-size: 12px">Blueprint: {{ branch.blueprint }}</n-text>
    </n-flex>
    <template #action>
      <n-flex justify="space-between" align="center">
        <n-button-group>
          <n-button
            size="small"
            type="success"
            secondary
            :disabled="isProcessing || branch.status === 'online'"
            :loading="branch.status === 'starting'"
            @click="handleStart">
            <template #icon><icon :path="mdiPlay" :size="16" /></template>
          </n-button>
          <n-button
            size="small"
            type="warning"
            secondary
            :disabled="isProcessing || branch.status === 'offline'"
            :loading="branch.status === 'stopping'"
            @click="handleStop">
            <template #icon><icon :path="mdiStop" :size="16" /></template>
          </n-button>
        </n-button-group>
        <n-popconfirm @positive-click="handleDelete" :positive-button-props="{ type: 'error' }">
          <template #trigger>
            <n-button size="small" type="error" quaternary :disabled="isProcessing">
              <template #icon><icon :path="mdiDelete" :size="16" /></template>
            </n-button>
          </template>
          Permanently delete this capsule branch and its branch data?
        </n-popconfirm>
      </n-flex>
    </template>
  </n-card>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { NCard, NText, NFlex, NTag, NButton, NButtonGroup, NPopconfirm, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { mdiPlay, mdiStop, mdiDelete, mdiCpu64Bit, mdiMemory } from '@mdi/js'
  import { useCapsuleContext } from '../composables/useCapsules'
  import { Icon } from './Icon'
  import type { CapsuleBranchItem } from '../types'

  const props = defineProps<{
    branch: CapsuleBranchItem
  }>()

  const message = useMessage()
  const { start, stop, delete: removeBranch } = useCapsuleContext()

  const isProcessing = computed(() => {
    return ['provisioning', 'starting', 'stopping'].includes(props.branch.status)
  })

  const statusType = computed(() => {
    switch (props.branch.status) {
      case 'online':
        return 'success'
      case 'provisioning':
      case 'starting':
      case 'stopping':
        return 'warning'
      case 'error':
        return 'error'
      default:
        return 'default'
    }
  })

  async function handleStart() {
    try {
      await start(props.branch.name)
      message.success('Capsule branch started')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to start capsule branch')
    }
  }

  async function handleStop() {
    try {
      await stop(props.branch.name)
      message.success('Capsule branch stopped')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to stop capsule branch')
    }
  }

  async function handleDelete() {
    try {
      await removeBranch(props.branch.name)
      message.success('Capsule branch deleted')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to delete capsule branch')
    }
  }
</script>
