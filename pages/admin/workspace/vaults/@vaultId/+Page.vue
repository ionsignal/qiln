<template>
  <div class="workspace-wrapper">
    <!-- File Browser Area -->
    <div class="workspace-content">
      <div v-if="!data.vault">
        <n-empty description="This vault does not exist or you do not have access." style="margin-top: 48px" />
      </div>
      <file-browser v-else :vault="vaultRef" />
    </div>
  </div>
</template>

<script setup lang="ts">
  import { onMounted, computed, watchEffect } from 'vue'
  import { NEmpty } from 'naive-ui'
  import { useData } from '@/composables/useData'
  import { injectVaultSidebar } from '@/composables/useVaultSidebar'
  import { provideFileBrowser, FileBrowser, buildDirectoryTreeOptions } from '@qiln/engine/client'
  import type { Data } from './+data'

  const data = useData<Data>()
  const vaultRef = computed(() => data.value.vault)
  const { currentPath, treeExpandedKeys, navigateTo, init } = provideFileBrowser({ vault: vaultRef })
  const vaultSidebar = injectVaultSidebar()

  watchEffect(() => {
    if (vaultRef.value) {
      vaultSidebar.vaultId = vaultRef.value.id
      vaultSidebar.vaultName = vaultRef.value.name
      vaultSidebar.directoryTree = buildDirectoryTreeOptions(vaultRef.value.root, '/')
    }
  })

  watchEffect(() => {
    vaultSidebar.activePath = currentPath.value
    vaultSidebar.expandedKeys = treeExpandedKeys.value
  })

  vaultSidebar.onNavigate = (keys: Array<string | number>) => {
    if (keys.length > 0) {
      navigateTo(keys[0] as string)
    }
  }

  vaultSidebar.onExpandChange = (keys: Array<string | number>) => {
    treeExpandedKeys.value = keys as string[]
  }

  onMounted(() => {
    init()
  })
</script>

<style scoped>
  .workspace-wrapper {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    padding: 24px;
    gap: 16px;
    box-sizing: border-box;
  }

  .workspace-header {
    flex-shrink: 0;
  }

  .workspace-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
