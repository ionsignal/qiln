<template>
  <n-drawer :show="show" :width="400" placement="right" @update:show="handleUpdateShow">
    <n-drawer-content title="Create Capsule Branch" closable>
      <n-form :model="form" @submit.prevent="handleSubmit">
        <n-form-item label="Branch Name" path="name">
          <n-input v-model:value="form.name" placeholder="e.g. sdxl-campaign-branch" :disabled="isSubmitting" />
        </n-form-item>
        <n-form-item label="Capsule Blueprint" path="blueprint">
          <n-select
            v-model:value="form.blueprint"
            :options="blueprintOptions"
            placeholder="Select a capsule blueprint"
            :disabled="isSubmitting" />
          <n-text v-if="selectedBlueprint" depth="3" class="blueprint-digest">Digest: {{ shortSelectedDigest }}</n-text>
        </n-form-item>
        <n-form-item label="Branch CPU Limit" path="cpu">
          <n-slider v-model:value="form.cpu" :min="1" :max="16" :marks="{ 1: '1', 4: '4', 8: '8', 16: '16' }" :disabled="isSubmitting" />
        </n-form-item>
        <n-form-item label="Branch Memory Limit (GB)" path="memory">
          <n-slider v-model:value="form.memory" :min="1" :max="32" :marks="{ 1: '1', 8: '8', 16: '16', 32: '32' }" :disabled="isSubmitting" />
        </n-form-item>
        <n-button block type="primary" attr-type="submit" :loading="isSubmitting" style="margin-top: 24px">Create Capsule Branch</n-button>
      </n-form>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
  import { ref, watch, computed } from 'vue'
  import { NDrawer, NDrawerContent, NForm, NFormItem, NInput, NSelect, NSlider, NButton, NText, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import { CapsuleBranchIdempotencyKeySchema, type CapsuleBlueprintManifestItem } from '@qiln/core/client'
  import { useCapsuleContext } from '../composables/useCapsules'

  const props = defineProps<{
    show: boolean
    blueprints: CapsuleBlueprintManifestItem[]
    preselectedBlueprint?: string
  }>()

  const emit = defineEmits<{
    (e: 'update:show', value: boolean): void
  }>()

  const message = useMessage()
  const { create } = useCapsuleContext()
  const isSubmitting = ref(false)

  const form = ref({
    name: '',
    blueprint: resolveInitialBlueprint(),
    cpu: 4,
    memory: 4,
  })

  const blueprintOptions = computed(() => {
    return props.blueprints.map(blueprint => ({
      label: blueprint.displayName,
      value: blueprint.name,
    }))
  })

  const selectedBlueprint = computed(() => {
    return props.blueprints.find(blueprint => blueprint.name === form.value.blueprint) ?? null
  })

  const shortSelectedDigest = computed(() => {
    if (!selectedBlueprint.value) {
      return ''
    }
    return shortDigest(selectedBlueprint.value.digest)
  })

  watch(
    () => props.show,
    newVal => {
      if (newVal) {
        form.value = {
          name: '',
          blueprint: resolveInitialBlueprint(),
          cpu: 4,
          memory: 4,
        }
      } else {
        isSubmitting.value = false
      }
    },
  )

  watch(
    () => props.blueprints,
    () => {
      if (props.show && !selectedBlueprint.value) {
        form.value.blueprint = resolveInitialBlueprint()
      }
    },
  )

  function resolveInitialBlueprint(): string {
    if (props.preselectedBlueprint && props.blueprints.some(blueprint => blueprint.name === props.preselectedBlueprint)) {
      return props.preselectedBlueprint
    }
    return props.blueprints[0]?.name ?? ''
  }

  function shortDigest(digest: string): string {
    const normalizedDigest = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest
    const digestPreview = normalizedDigest.length > 12 ? `${normalizedDigest.slice(0, 12)}…` : normalizedDigest
    return digest.startsWith('sha256:') ? `sha256:${digestPreview}` : digestPreview
  }

  function generateIdempotencyKey(): string | null {
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      return null
    }
    const parsed = CapsuleBranchIdempotencyKeySchema.safeParse(globalThis.crypto.randomUUID())
    return parsed.success ? parsed.data : null
  }

  function handleUpdateShow(value: boolean) {
    emit('update:show', value)
  }

  async function handleSubmit() {
    const name = form.value.name.trim()
    if (!name || !form.value.blueprint) {
      message.warning('Please provide a branch name and capsule blueprint.')
      return
    }
    const blueprint = selectedBlueprint.value
    if (!blueprint) {
      message.warning('Please select a capsule blueprint from the current manifest.')
      return
    }
    const idempotencyKey = generateIdempotencyKey()
    if (!idempotencyKey) {
      message.error('Failed to generate a branch create idempotency key. Please retry in a modern browser.')
      return
    }
    isSubmitting.value = true
    try {
      await create({
        name,
        blueprintName: blueprint.name,
        blueprintDigest: blueprint.digest,
        idempotencyKey,
        cpu: form.value.cpu.toString(),
        memory: `${form.value.memory}GB`,
      })
      message.success('Capsule branch creation started.')
      emit('update:show', false)
    } catch (err: unknown) {
      message.error(isTRPCClientError(err) ? err.message : 'Failed to create capsule branch.')
    } finally {
      isSubmitting.value = false
    }
  }
</script>

<style scoped>
  .blueprint-digest {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    word-break: break-all;
  }
</style>
