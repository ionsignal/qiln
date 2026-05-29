<template>
  <n-layout-sider
    bordered
    :width="56"
    :native-scrollbar="false"
    style="--n-color: transparent"
    content-style="height: 100%;"
    class="qiln-global-rail">
    <n-flex vertical align="center" :size="6" class="rail-floating-panel">
      <!-- Workspace -->
      <n-tooltip placement="right">
        <template #trigger>
          <n-button
            @click="navigate('/admin/workspace')"
            class="rail-btn"
            :type="activeContext === 'workspace' ? 'primary' : 'default'"
            :quaternary="activeContext !== 'workspace'"
            :secondary="activeContext === 'workspace'">
            <template #icon>
              <icon :path="mdiMonitorDashboard" />
            </template>
          </n-button>
        </template>
        Workspace
      </n-tooltip>
      <!-- Forge -->
      <n-tooltip placement="right">
        <template #trigger>
          <n-button
            @click="navigate('/admin/forge')"
            class="rail-btn"
            :type="activeContext === 'forge' ? 'primary' : 'default'"
            :quaternary="activeContext !== 'forge'"
            :secondary="activeContext === 'forge'">
            <template #icon>
              <icon :path="mdiAnvil" />
            </template>
          </n-button>
        </template>
        Forge
      </n-tooltip>
      <!-- Operations -->
      <n-tooltip placement="right">
        <template #trigger>
          <n-button
            @click="navigate('/admin/operations')"
            class="rail-btn"
            :type="activeContext === 'operations' ? 'primary' : 'default'"
            :quaternary="activeContext !== 'operations'"
            :secondary="activeContext === 'operations'">
            <template #icon>
              <icon :path="mdiConsoleLine" />
            </template>
          </n-button>
        </template>
        Operations Center
      </n-tooltip>
    </n-flex>
  </n-layout-sider>
</template>

<script setup lang="ts">
  import { NLayoutSider, NFlex, NTooltip, NButton } from 'naive-ui'
  import { Icon } from '@/components/Icon'
  import { mdiMonitorDashboard, mdiAnvil, mdiConsoleLine } from '@mdi/js'
  import { useQilnNavigation } from '../../composables/useQilnNavigation'
  import { navigate } from 'vike/client/router'

  const { activeContext } = useQilnNavigation()
</script>

<style scoped>
  .qiln-global-rail {
    z-index: 2;
  }

  .rail-floating-panel {
    height: calc(100%);
    margin: 0 5px;
    padding: 5px 0;
    box-sizing: border-box;
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    border: 1px solid var(--n-border-color);
    border-bottom: none;
  }

  .rail-btn {
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: 8px;
  }

  :deep(.rail-btn.n-button--default-type.n-button--quaternary-type) {
    color: rgba(255, 255, 255, 0.4);
  }

  :deep(.rail-btn.n-button--default-type) {
    background-color: rgb(22, 22, 26);
    color: rgba(255, 255, 255, 0.4);
  }

  :deep(.rail-btn.n-button--default-type.n-button--quaternary-type:hover) {
    color: rgba(255, 255, 255, 0.9);
    background-color: rgba(255, 255, 255, 0.08);
  }
</style>
