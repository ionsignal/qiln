<template>
  <n-card bordered embedded size="small" class="instance-card">
    <template #header>
      <n-text style="font-weight: 600; letter-spacing: 0.05em">{{ instance.name }}</n-text>
    </template>
    <template #header-extra>
      <n-tag :type="statusType" size="small" round :bordered="false">
        {{ instance.status.toUpperCase() }}
      </n-tag>
    </template>
    <n-flex vertical :size="12">
      <n-flex :size="16" align="center">
        <n-flex :size="6" align="center">
          <icon :path="mdiCpu64Bit" :size="16" style="opacity: 0.5" />
          <n-text depth="2">{{ instance.cpu }} Cores</n-text>
        </n-flex>
        <n-flex :size="6" align="center">
          <icon :path="mdiMemory" :size="16" style="opacity: 0.5" />
          <n-text depth="2">{{ instance.memory }}</n-text>
        </n-flex>
      </n-flex>
      <n-text depth="3" style="font-size: 12px">Blueprint: {{ instance.blueprint }}</n-text>
    </n-flex>
    <template #action>
      <n-flex justify="space-between" align="center">
        <n-button-group>
          <n-button
            size="small"
            type="success"
            secondary
            :disabled="isProcessing || instance.status === 'online'"
            :loading="instance.status === 'starting'"
            @click="handleStart">
            <template #icon><icon :path="mdiPlay" :size="16" /></template>
          </n-button>
          <n-button
            size="small"
            type="warning"
            secondary
            :disabled="isProcessing || instance.status === 'offline'"
            :loading="instance.status === 'stopping'"
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
          Are you sure you want to permanently delete this capsule branch and its data?
        </n-popconfirm>
      </n-flex>
    </template>
  </n-card>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { NCard, NText, NFlex, NTag, NButton, NButtonGroup, NPopconfirm, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { useCapsuleContext } from '../composables/useCapsules'
  import { Icon } from './Icon'
  import { mdiPlay, mdiStop, mdiDelete, mdiCpu64Bit, mdiMemory } from '@mdi/js'
  import type { CapsuleBranchItem } from '../types'

  const props = defineProps<{
    instance: CapsuleBranchItem
  }>()

  const message = useMessage()
  const { start, stop, delete: removeBranch } = useCapsuleContext()

  const isProcessing = computed(() => {
    return ['provisioning', 'starting', 'stopping'].includes(props.instance.status)
  })

  const statusType = computed(() => {
    switch (props.instance.status) {
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
      await start(props.instance.name)
      message.success('Capsule branch starting...')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to start capsule branch')
    }
  }

  async function handleStop() {
    try {
      await stop(props.instance.name)
      message.success('Capsule branch stopping...')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to stop capsule branch')
    }
  }

  async function handleDelete() {
    try {
      await removeBranch(props.instance.name)
      message.success('Capsule branch deleted')
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to delete capsule branch')
    }
  }
</script>
