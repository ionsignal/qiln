<template>
  <n-drawer :show="show" :width="400" placement="right" @update:show="handleUpdateShow">
    <n-drawer-content title="Create Capsule" closable>
      <n-form :model="form" @submit.prevent="handleSubmit">
        <n-form-item label="Root Branch Name" path="rootBranchName">
          <n-input v-model:value="form.rootBranchName" placeholder="e.g. sdxl-campaign" :disabled="isSubmitting" />
        </n-form-item>
        <n-form-item label="Capsule Blueprint" path="blueprint">
          <n-select
            v-model:value="form.blueprint"
            :options="blueprintOptions"
            placeholder="Select a capsule blueprint"
            :disabled="isSubmitting" />
          <n-text v-if="selectedBlueprint" depth="3" class="blueprint-digest">Digest: {{ shortSelectedDigest }}</n-text>
        </n-form-item>
        <n-form-item label="Root Branch CPU Limit" path="cpu">
          <n-slider v-model:value="form.cpu" :min="1" :max="16" :marks="{ 1: '1', 4: '4', 8: '8', 16: '16' }" :disabled="isSubmitting" />
        </n-form-item>
        <n-form-item label="Root Branch Memory Limit (GB)" path="memory">
          <n-slider v-model:value="form.memory" :min="1" :max="32" :marks="{ 1: '1', 8: '8', 16: '16', 32: '32' }" :disabled="isSubmitting" />
        </n-form-item>
        <n-button block type="primary" attr-type="submit" :loading="isSubmitting" style="margin-top: 24px">Create Capsule</n-button>
      </n-form>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { NButton, NDrawer, NDrawerContent, NForm, NFormItem, NInput, NSelect, NSlider, NText, useMessage } from 'naive-ui'
  import { isTRPCClientError } from '@trpc/client'
  import {
    CapsuleLifecycleIdempotencyKeySchema,
    type CapsuleBlueprintManifestItem,
    type CapsuleLifecycleIdempotencyKey,
  } from '@qiln/core/client'
  import { useCapsuleContext } from '../composables/useCapsules'

  interface CapsuleCreateForm {
    rootBranchName: string
    blueprint: string
    cpu: number
    memory: number
  }

  interface PendingSubmission {
    fingerprint: string
    idempotencyKey: CapsuleLifecycleIdempotencyKey
  }

  const props = defineProps<{
    show: boolean
    blueprints: CapsuleBlueprintManifestItem[]
    preselectedBlueprint?: string
  }>()

  const emit = defineEmits<{
    (event: 'update:show', value: boolean): void
  }>()

  const message = useMessage()
  const { createCapsule } = useCapsuleContext()
  const isSubmitting = ref(false)
  const pendingSubmission = ref<PendingSubmission | null>(null)
  const form = ref<CapsuleCreateForm>(createInitialForm())

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
    show => {
      if (show) {
        form.value = createInitialForm()
        pendingSubmission.value = null
        return
      }
      isSubmitting.value = false
      pendingSubmission.value = null
    },
  )

  watch(
    () => props.blueprints,
    () => {
      if (props.show && !selectedBlueprint.value) {
        form.value.blueprint = resolveInitialBlueprint()
        pendingSubmission.value = null
      }
    },
  )

  function createInitialForm(): CapsuleCreateForm {
    return {
      rootBranchName: '',
      blueprint: resolveInitialBlueprint(),
      cpu: 4,
      memory: 4,
    }
  }

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

  function generateIdempotencyKey(): CapsuleLifecycleIdempotencyKey | null {
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      return null
    }
    const parsed = CapsuleLifecycleIdempotencyKeySchema.safeParse(globalThis.crypto.randomUUID())
    return parsed.success ? parsed.data : null
  }

  function resolveIdempotencyKey(fingerprint: string): CapsuleLifecycleIdempotencyKey | null {
    if (pendingSubmission.value?.fingerprint === fingerprint) {
      return pendingSubmission.value.idempotencyKey
    }
    const idempotencyKey = generateIdempotencyKey()
    if (!idempotencyKey) {
      return null
    }
    pendingSubmission.value = {
      fingerprint,
      idempotencyKey,
    }
    return idempotencyKey
  }

  function handleUpdateShow(value: boolean): void {
    emit('update:show', value)
  }

  async function handleSubmit(): Promise<void> {
    const rootBranchName = form.value.rootBranchName.trim()
    if (!rootBranchName || !form.value.blueprint) {
      message.warning('Please provide a root branch name and capsule blueprint.')
      return
    }
    const blueprint = selectedBlueprint.value
    if (!blueprint) {
      message.warning('Please select a capsule blueprint from the current manifest.')
      return
    }
    const request = {
      rootBranchName,
      blueprintName: blueprint.name,
      blueprintDigest: blueprint.digest,
      cpu: form.value.cpu.toString(),
      memory: `${form.value.memory}GB`,
    }
    const fingerprint = JSON.stringify(request)
    const idempotencyKey = resolveIdempotencyKey(fingerprint)
    if (!idempotencyKey) {
      message.error('Failed to generate a capsule lifecycle idempotency key. Please retry in a modern browser.')
      return
    }
    isSubmitting.value = true
    try {
      await createCapsule({
        ...request,
        idempotencyKey,
      })
      pendingSubmission.value = null
      message.success('Capsule created with an offline root branch.')
      emit('update:show', false)
    } catch (error: unknown) {
      message.error(isTRPCClientError(error) ? error.message : 'Failed to create capsule.')
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
