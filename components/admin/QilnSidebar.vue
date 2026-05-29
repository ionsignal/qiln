<template>
  <n-layout-sider
    bordered
    collapse-mode="width"
    :collapsed-width="64"
    :width="288"
    :show-trigger="!vaultSidebar.active"
    v-model:collapsed="isCollapsed"
    class="qiln-sidebar">
    <div class="sidebar-layout-wrapper">
      <div v-if="!vaultSidebar.active" class="standard-sidebar-container">
        <div class="sidebar-header">
          <n-text class="sidebar-title">{{ sidebarTitle }}</n-text>
          <n-dropdown placement="bottom-end" :options="createOptions" @select="handleCreateSelect">
            <n-button class="create-resource-btn" size="tiny">
              <template #icon><icon :path="mdiPlus" /></template>
            </n-button>
          </n-dropdown>
        </div>
        <div class="standard-menu-wrapper">
          <n-menu
            :options="currentMenuTree"
            :value="activeMenuKey"
            :expanded-keys="resolvedExpandedKeys"
            @update:expanded-keys="handleExpandedKeysChange"
            :expand-icon="renderExpandIcon"
            :node-props="menuNodeProps"
            :root-indent="16"
            :indent="8"
            :collapsed-width="64"
            :collapsed-icon-size="14" />
        </div>
      </div>
      <div v-else class="vault-sidebar-container">
        <div class="vault-header">
          <a-link href="/admin/workspace/vaults" class="back-link">
            <icon :path="mdiArrowLeft" :size="14" style="margin-right: 4px" />
            Back to Vaults
          </a-link>
        </div>
        <n-divider style="margin: 8px 0" />
        <div class="vault-tree-wrapper">
          <n-tree
            block-line
            expand-on-click
            :data="vaultSidebar.directoryTree"
            :selected-keys="vaultSidebar.activePath ? [vaultSidebar.activePath] : []"
            :expanded-keys="vaultSidebar.expandedKeys"
            @update:selected-keys="handleTreeSelect"
            @update:expanded-keys="vaultSidebar.onExpandChange" />
        </div>
      </div>
    </div>
  </n-layout-sider>
</template>

<script setup lang="ts">
  import { ref, watch, computed, h } from 'vue'
  import { NLayoutSider, NMenu, NTree, NDivider, NDropdown, NText, NButton } from 'naive-ui'
  import type { DropdownOption } from 'naive-ui'
  import { useQilnNavigation } from '../../composables/useQilnNavigation'
  import { injectVaultSidebar } from '../../composables/useVaultSidebar'
  import { ALink } from '@/components/ALink'
  import { Icon } from '@/components/Icon'
  import { mdiArrowLeft, mdiPlus, mdiServerNetwork, mdiCubeOutline, mdiSafe } from '@mdi/js'

  const { activeContext, currentMenuTree, activeMenuKey, resolvedExpandedKeys, handleExpandedKeysChange, renderExpandIcon, menuNodeProps } =
    useQilnNavigation()
  const vaultSidebar = injectVaultSidebar()
  const isCollapsed = ref(false)
  const sidebarTitle = computed(() => {
    const ctx = activeContext.value
    return ctx.charAt(0).toUpperCase() + ctx.slice(1)
  })

  const renderIcon = (path: string) => () => h(Icon, { path, size: 14 })

  const createOptions = computed<DropdownOption[]>(() => {
    if (activeContext.value === 'forge') {
      return [
        { label: 'New Blueprint', key: 'create-blueprint', icon: renderIcon(mdiCubeOutline) },
        { label: 'New Image Build', key: 'create-image', icon: renderIcon(mdiCubeOutline) },
      ]
    }
    return [
      { label: 'Cast New Vessel', key: 'create-vessel', icon: renderIcon(mdiServerNetwork) },
      { label: 'Provision Vault', key: 'create-vault', icon: renderIcon(mdiSafe) },
    ]
  })

  function handleCreateSelect(key: string) {
    console.log(`[QilnSidebar] Create action selected: ${key}`)
  }

  watch(
    () => vaultSidebar.active,
    val => {
      if (val) {
        isCollapsed.value = false
      }
    },
  )

  function handleTreeSelect(keys: Array<string | number>) {
    if (keys.length > 0) {
      vaultSidebar.onNavigate(keys)
    }
  }
</script>

<style scoped>
  .qiln-sidebar {
    border-top: 1px solid var(--n-border-color);
  }

  .sidebar-layout-wrapper {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .standard-sidebar-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .sidebar-header {
    height: 40px;
    padding: 0 8px 0 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    flex-shrink: 0;
  }

  .sidebar-title {
    font-weight: 600;
    letter-spacing: 0.05em;
    font-size: 13px;
    color: var(--n-text-color-1);
  }

  .create-resource-btn {
    --n-color: rgba(0, 0, 0, 0.25) !important;
    --n-color-hover: rgba(255, 255, 255, 0.08) !important;
    --n-color-pressed: rgba(0, 0, 0, 0.4) !important;
    --n-border: 1px solid rgba(255, 255, 255, 0.08) !important;
    --n-border-hover: 1px solid rgba(255, 255, 255, 0.15) !important;
    --n-text-color: rgba(255, 255, 255, 0.7) !important;
    --n-text-color-hover: rgba(255, 255, 255, 1) !important;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
    border-radius: 6px;
    transition: box-shadow 0.3s var(--n-bezier);
  }

  .create-resource-btn:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.7);
  }

  .standard-menu-wrapper {
    flex: 1;
    overflow-y: auto;
  }

  .vault-sidebar-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .vault-header {
    padding: 16px 16px 0 16px;
    flex-shrink: 0;
  }

  .back-link {
    display: flex;
    align-items: center;
    font-size: 12px;
    color: var(--n-text-color-3);
    text-decoration: none;
    transition: color 0.2s;
    margin-bottom: 8px;
  }

  .back-link:hover {
    color: var(--n-text-color-1);
  }

  .vault-tree-wrapper {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px 16px 8px;
  }

  :deep(.n-menu .n-menu-item) {
    margin-top: 5px;
  }

  :deep(.qiln-root-action) {
    --n-item-height: 34px !important;
    --n-border-radius: 8px !important;
  }
</style>
