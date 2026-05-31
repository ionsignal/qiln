<template>
  <n-config-provider :theme="darkTheme" :locale="enUS" :date-locale="dateEnUS" :theme-overrides="adminThemeOverrides">
    <n-global-style />
    <n-notification-provider>
      <n-message-provider :duration="6000">
        <n-dialog-provider>
          <n-loading-bar-provider :to="false">
            <TransitionDispatcher />
            <n-layout position="absolute" class="qiln-admin-root">
              <n-layout-header class="admin-header-grid">
                <!-- Left: Logo -->
                <div class="header-left">
                  <n-flex align="center" :size="16">
                    <n-text style="font-size: 18px; font-weight: 700; letter-spacing: 0.1em">Qiln</n-text>
                  </n-flex>
                </div>
                <!-- Center: Command Palette -->
                <div class="header-center">
                  <n-auto-complete
                    ref="searchRef"
                    class="command-palette"
                    placeholder="Search resources..."
                    size="small"
                    v-model:value="searchValue"
                    :options="searchOptions"
                    :render-label="renderSearchLabel"
                    :clear-after-select="true"
                    @focus="isSearchFocused = true"
                    @blur="isSearchFocused = false">
                    <template #prefix>
                      <icon :path="mdiMagnify" :size="16" style="opacity: 0.5; margin-right: 4px" />
                    </template>
                    <template #suffix>
                      <div v-if="!searchValue && !isSearchFocused" class="search-shortcut">{{ searchShortcut }}</div>
                    </template>
                  </n-auto-complete>
                </div>
                <!-- Right: Actions -->
                <div class="header-right">
                  <n-flex align="center" :size="10">
                    <n-badge :value="3" :max="99">
                      <n-button quaternary circle size="tiny">
                        <template #icon>
                          <icon :path="mdiBellOutline" />
                        </template>
                      </n-button>
                    </n-badge>
                    <n-dropdown placement="bottom-end" :options="userMenuOptions" @select="handleUserMenuSelect">
                      <div class="user-profile-trigger">
                        <n-avatar round size="small" src="https://i.pravatar.cc/150?img=32" fallback-src="https://i.pravatar.cc/150?img=3" />
                        <icon :path="mdiChevronDown" :size="16" style="opacity: 0.5" />
                      </div>
                    </n-dropdown>
                  </n-flex>
                </div>
              </n-layout-header>
              <n-layout has-sider position="absolute" style="top: 48px; bottom: 0">
                <qiln-rail />
                <qiln-sidebar />
                <n-layout-content native-scrollbar style="border-top: 1px solid rgba(255, 255, 255, 0.08)" content-style="padding: 32px;">
                  <slot />
                </n-layout-content>
              </n-layout>
            </n-layout>
          </n-loading-bar-provider>
        </n-dialog-provider>
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<script lang="ts" setup>
  import 'vfonts/Roboto.css'
  import 'vfonts/FiraCode.css'
  import { h, computed, ref, onMounted, onUnmounted, defineComponent } from 'vue'
  import { Icon } from '@/components/Icon'
  import { transitionBus } from '@/renderer/utils/transitions'
  import { adminThemeOverrides } from '@/renderer/layout/adminThemeOverrides'

  import QilnRail from '@/components/admin/QilnRail.vue'
  import QilnSidebar from '@/components/admin/QilnSidebar.vue'

  import { mdiChevronDown, mdiBellOutline, mdiCog, mdiLogout, mdiMagnify, mdiHome, mdiServerNetwork, mdiCubeOutline, mdiSafe } from '@mdi/js'

  import {
    NConfigProvider,
    NGlobalStyle,
    NNotificationProvider,
    NMessageProvider,
    NDialogProvider,
    NLoadingBarProvider,
    NAutoComplete,
    useLoadingBar,
    NLayout,
    NLayoutHeader,
    NLayoutContent,
    NFlex,
    NText,
    NButton,
    NBadge,
    NDropdown,
    NAvatar,
    darkTheme,
    enUS,
    dateEnUS,
    type AutoCompleteInst,
    type AutoCompleteGroupOption,
    type AutoCompleteOption,
    type DropdownOption,
  } from 'naive-ui'

  import { provideVaultSidebar } from '@/composables/useVaultSidebar'

  provideVaultSidebar()

  const TransitionDispatcher = defineComponent({
    name: 'TransitionDispatcher',
    setup() {
      const loadingBar = useLoadingBar()
      const onStart = () => loadingBar.start()
      const onFinish = () => loadingBar.finish()
      const onError = () => loadingBar.error()
      onMounted(() => {
        transitionBus.on('start', onStart)
        transitionBus.on('finish', onFinish)
        transitionBus.on('error', onError)
      })
      onUnmounted(() => {
        transitionBus.off('start', onStart)
        transitionBus.off('finish', onFinish)
        transitionBus.off('error', onError)
      })
      return () => null
    },
  })

  const searchRef = ref<AutoCompleteInst | null>(null)
  const searchShortcut = ref('Ctrl+K')
  const searchValue = ref('')
  const isSearchFocused = ref(false)

  const handleKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      searchRef.value?.focus()
    }
  }

  onMounted(() => {
    if (typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0) {
      searchShortcut.value = '⌘K'
    }
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
  })

  type SearchOption = AutoCompleteOption & { resourceType?: 'vessel' | 'mold' | 'vault' }

  const allMockOptions: AutoCompleteGroupOption[] = [
    {
      type: 'group',
      label: 'Vessels',
      key: 'vessels',
      children: [
        { label: 'prod-vllm-01', value: 'prod-vllm-01', resourceType: 'vessel' },
        { label: 'auth-db-01', value: 'auth-db-01', resourceType: 'vessel' },
      ] as SearchOption[],
    },
    {
      type: 'group',
      label: 'Molds',
      key: 'molds',
      children: [
        { label: 'vLLM Inference', value: 'mold-vllm', resourceType: 'mold' },
        { label: 'ComfyUI Workspace', value: 'mold-comfy', resourceType: 'mold' },
      ] as SearchOption[],
    },
    {
      type: 'group',
      label: 'Vaults',
      key: 'vaults',
      children: [{ label: 'is-model-vault', value: 'is-model-vault', resourceType: 'vault' }] as SearchOption[],
    },
  ]

  const searchOptions = computed(() => {
    if (!searchValue.value) return allMockOptions
    const query = searchValue.value.toLowerCase()
    return allMockOptions
      .map(group => {
        const filteredChildren = (group.children as SearchOption[]).filter(child => String(child.label).toLowerCase().includes(query))
        return { ...group, children: filteredChildren }
      })
      .filter(group => group.children.length > 0)
  })

  const renderSearchLabel = (info: SearchOption) => {
    let iconPath = mdiServerNetwork
    if (info.resourceType === 'mold') iconPath = mdiCubeOutline
    if (info.resourceType === 'vault') iconPath = mdiSafe
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
      h(Icon, { path: iconPath, size: 14, style: { opacity: 0.5 } }),
      h('span', info.label as string),
    ])
  }

  const renderIcon = (path: string) => () => h(Icon, { path, size: 14 })

  const userMenuOptions: DropdownOption[] = [
    {
      label: 'Settings',
      key: 'settings',
      icon: renderIcon(mdiCog),
    },
    {
      type: 'divider',
      key: 'd1',
    },
    {
      label: 'Exit Admin',
      key: 'exit',
      icon: renderIcon(mdiHome),
    },
    {
      label: 'Logout',
      key: 'logout',
      icon: renderIcon(mdiLogout),
    },
  ]

  function handleUserMenuSelect(key: string) {
    switch (key) {
      case 'exit':
        window.location.href = '/'
        break
      case 'settings':
        console.log('Settings clicked (stub)')
        break
      case 'logout':
        console.log('Logout clicked (stub) - ready for trpc.auth.logout.mutate()')
        break
    }
  }
</script>

<style scoped>
  .admin-header-grid {
    display: grid;
    grid-template-columns: 1fr minmax(200px, 400px) 1fr;
    align-items: center;
    height: 48px;
    padding: 0 5px 0 10px;
  }

  .header-left {
    display: flex;
    align-items: center;
    justify-content: flex-start;
  }

  .header-center {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
  }

  .header-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  .command-palette {
    width: 100%;
    max-width: 320px;
  }

  .search-shortcut {
    display: flex;
    height: 17px;
    font-size: 10px;
    font-weight: 600;
    line-height: 12px;
    color: rgba(255, 255, 255, 0.4);
    background: rgba(255, 255, 255, 0.1);
    padding: 0 4px 0 3px;
    border-radius: 8px;
    pointer-events: none;
    user-select: none;
    align-items: center;
    justify-content: center;
  }

  .user-profile-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.3s var(--n-bezier);
  }

  .user-profile-trigger:hover {
    background-color: rgba(255, 255, 255, 0.08);
  }

  :deep(.n-badge-sup) {
    height: 14px;
    padding: 0 4px;
  }

  :deep(.qiln-category-header > .n-menu-item-content) {
    height: 32px !important;
  }

  :deep(.qiln-category-header > .n-menu-item-content::before) {
    display: none !important;
  }

  :deep(.n-menu-item-content-header) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  :deep(.n-menu-item-content-header__extra) {
    display: flex;
  }

  :deep(.quick-provision-btn) {
    --n-color: rgba(255, 255, 255, 0.08) !important;
    --n-text-color: rgba(255, 255, 255, 0.4) !important;
    --n-border: 1px solid transparent !important;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  :deep(.n-menu-item-content:hover .quick-provision-btn) {
    --n-color: rgba(34, 197, 94, 0.2) !important;
    --n-text-color: #4ade80 !important;
  }

  :deep(.n-menu-item-content:hover .quick-provision-btn:hover) {
    --n-color: #22c55e !important;
    --n-text-color: #fff !important;
  }
</style>

<style>
  body {
    overflow: hidden;
  }

  .qiln-admin-root {
    --qiln-telemetry-cool: #8b5cf6;
    --qiln-telemetry-healthy: #22c55e;
    --qiln-telemetry-elevated: #f59e0b;
    --qiln-telemetry-critical: #f43f5e;
    --qiln-surface-border-strong: rgba(255, 255, 255, 0.08);
    --qiln-surface-highlight: rgba(255, 255, 255, 0.025);
  }
</style>
