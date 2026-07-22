<template>
  <n-layout-sider
    bordered
    collapse-mode="width"
    :collapsed-width="64"
    :width="288"
    show-trigger
    v-model:collapsed="isCollapsed"
    class="qiln-sidebar">
    <div class="sidebar-layout-wrapper">
      <div class="standard-sidebar-container">
        <div class="sidebar-header">
          <n-text class="sidebar-title">{{ sidebarTitle }}</n-text>
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
    </div>
  </n-layout-sider>
</template>

<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { NLayoutSider, NMenu, NText } from 'naive-ui'
  import { useQilnNavigation } from '../../composables/useQilnNavigation'

  const {
    activeContext,
    currentMenuTree,
    activeMenuKey,
    resolvedExpandedKeys,
    handleExpandedKeysChange,
    renderExpandIcon,
    menuNodeProps,
  } = useQilnNavigation()
  const isCollapsed = ref(false)
  const sidebarTitle = computed(() => {
    if (activeContext.value === 'operations') {
      return 'Operations'
    }
    return 'Capsules'
  })
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

  .standard-menu-wrapper {
    flex: 1;
    overflow-y: auto;
  }

  :deep(.n-menu .n-menu-item) {
    margin-top: 5px;
  }

  :deep(.qiln-root-action) {
    --n-item-height: 34px !important;
    --n-border-radius: 8px !important;
  }

  :deep(.qiln-category-header > .n-menu-item-content) {
    height: 32px !important;
  }

  :deep(.qiln-category-header > .n-menu-item-content::before) {
    display: none !important;
  }
</style>
