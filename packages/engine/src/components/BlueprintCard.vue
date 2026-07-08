<template>
  <n-card bordered embedded size="small" class="blueprint-card">
    <template #header>
      <n-flex vertical :size="4">
        <n-text class="blueprint-title">{{ blueprint.displayName }}</n-text>
        <n-text depth="3" class="blueprint-name">{{ blueprint.name }}</n-text>
      </n-flex>
    </template>
    <n-flex vertical :size="14">
      <n-text depth="3" class="blueprint-description">
        {{ blueprint.description }}
      </n-text>
      <n-flex :size="8" wrap>
        <n-tag size="small" :bordered="false" type="info">
          <template #icon>
            <icon :path="mdiLayers" :size="14" />
          </template>
          Capsule Blueprint
        </n-tag>
        <n-tag size="small" :bordered="false" :title="blueprint.name">
          <template #icon>
            <icon :path="mdiTag" :size="14" />
          </template>
          {{ blueprint.name }}
        </n-tag>
        <n-tag size="small" :bordered="false" :title="blueprint.digest">
          <template #icon>
            <icon :path="mdiFingerprint" :size="14" />
          </template>
          {{ shortDigest }}
        </n-tag>
      </n-flex>
    </n-flex>
    <template #action>
      <n-button block type="primary" size="small" @click="$emit('create-branch', blueprint.name)">Create Capsule Branch</n-button>
    </template>
  </n-card>
</template>

<script setup lang="ts">
  import { computed } from 'vue'
  import { NCard, NText, NFlex, NTag, NButton } from 'naive-ui'
  import { mdiFingerprint, mdiLayers, mdiTag } from '@mdi/js'
  import { Icon } from './Icon'
  import type { CapsuleBlueprintManifestItem } from '@qiln/core/client'

  const props = defineProps<{
    blueprint: CapsuleBlueprintManifestItem
  }>()

  defineEmits<{
    (e: 'create-branch', blueprintName: string): void
  }>()

  const shortDigest = computed(() => {
    const digest = props.blueprint.digest
    const normalizedDigest = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest
    const digestPreview = normalizedDigest.length > 12 ? `${normalizedDigest.slice(0, 12)}…` : normalizedDigest
    return digest.startsWith('sha256:') ? `sha256:${digestPreview}` : digestPreview
  })
</script>
