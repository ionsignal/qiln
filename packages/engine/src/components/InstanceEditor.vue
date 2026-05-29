<template>
  <n-drawer :show="show" :width="400" placement="right" @update:show="handleUpdateShow">
    <n-drawer-content title="Provision Instance" closable>
      <n-form :model="form" @submit.prevent="handleSubmit">
        <n-form-item label="Instance Name" path="name">
          <n-input v-model:value="form.name" placeholder="e.g. survival-server-01" :disabled="isSubmitting" />
        </n-form-item>
        <n-form-item label="Blueprint" path="definition">
          <n-select v-model:value="form.definition" :options="blueprintOptions" placeholder="Select a Blueprint" :disabled="isSubmitting" />
        </n-form-item>
        <n-form-item label="CPU Cores" path="cpu">
          <n-slider v-model:value="form.cpu" :min="1" :max="16" :marks="{ 1: '1', 4: '4', 8: '8', 16: '16' }" :disabled="isSubmitting" />
        </n-form-item>
        <n-form-item label="Memory (GB)" path="memory">
          <n-slider v-model:value="form.memory" :min="1" :max="32" :marks="{ 1: '1', 8: '8', 16: '16', 32: '32' }" :disabled="isSubmitting" />
        </n-form-item>
        <n-button block type="primary" attr-type="submit" :loading="isSubmitting" style="margin-top: 24px">Provision</n-button>
      </n-form>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
  import { ref, watch, computed } from 'vue'
  import { NDrawer, NDrawerContent, NForm, NFormItem, NInput, NSelect, NSlider, NButton, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { useInstanceContext } from '../composables/useInstances'
  import type { AppDefinition } from '../schemas/definitions'

  const props = defineProps<{
    show: boolean
    blueprints: AppDefinition[]
    preselectedBlueprint?: string
  }>()

  const emit = defineEmits<{
    (e: 'update:show', value: boolean): void
  }>()

  const message = useMessage()
  const { create } = useInstanceContext()
  const isSubmitting = ref(false)

  const form = ref({
    name: '',
    definition: props.preselectedBlueprint || '',
    cpu: 4,
    memory: 4,
  })

  const blueprintOptions = computed(() => {
    return props.blueprints.map(bp => ({
      label: bp.display_name,
      value: bp.name,
    }))
  })

  watch(
    () => props.show,
    newVal => {
      if (newVal) {
        form.value = {
          name: '',
          definition: props.preselectedBlueprint || (props.blueprints[0]?.name ?? ''),
          cpu: 4,
          memory: 4,
        }
      } else {
        isSubmitting.value = false
      }
    },
  )

  function handleUpdateShow(val: boolean) {
    emit('update:show', val)
  }

  async function handleSubmit() {
    if (!form.value.name.trim() || !form.value.definition) {
      message.warning('Please fill out all required fields.')
      return
    }

    isSubmitting.value = true
    try {
      await create(form.value.name.trim(), form.value.definition, form.value.cpu.toString(), `${form.value.memory}GB`)
      message.success('Instance provisioning started.')
      emit('update:show', false)
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to provision instance.')
    } finally {
      isSubmitting.value = false
    }
  }
</script>
