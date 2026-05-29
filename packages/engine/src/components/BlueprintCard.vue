<template>
  <n-card bordered embedded size="small" class="blueprint-card">
    <template #header>
      <n-text style="font-weight: 600; letter-spacing: 0.05em">{{ blueprint.display_name }}</n-text>
    </template>
    <n-flex vertical :size="12">
      <n-text depth="3" style="font-size: 13px; line-height: 1.4">
        {{ blueprint.description }}
      </n-text>
      <n-flex :size="8" wrap>
        <n-tag size="small" :bordered="false" type="info">
          <template #icon><icon :path="mdiLayers" :size="14" /></template>
          {{ blueprint.image_alias }}
        </n-tag>
        <n-tag v-if="blueprint.provisioning.volumes.length" size="small" :bordered="false">
          <template #icon><icon :path="mdiHarddisk" :size="14" /></template>
          {{ blueprint.provisioning.volumes.length }} Vol
        </n-tag>
        <n-tag v-if="blueprint.application?.ports.length" size="small" :bordered="false">
          <template #icon><icon :path="mdiEthernet" :size="14" /></template>
          {{ blueprint.application.ports.length }} Port
        </n-tag>
      </n-flex>
    </n-flex>
    <template #action>
      <n-button block type="primary" size="small" @click="$emit('deploy', blueprint.name)">Deploy Instance</n-button>
    </template>
  </n-card>
</template>

<script setup lang="ts">
  import { NCard, NText, NFlex, NTag, NButton } from 'naive-ui'
  import { Icon } from './Icon'
  import { mdiLayers, mdiHarddisk, mdiEthernet } from '@mdi/js'
  import type { AppDefinition } from '../schemas/definitions'

  defineProps<{
    blueprint: AppDefinition
  }>()

  defineEmits<{
    (e: 'deploy', blueprintName: string): void
  }>()
</script>
