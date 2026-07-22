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
                <div class="header-left">
                  <n-flex align="center" :size="16">
                    <n-text style="font-size: 18px; font-weight: 700; letter-spacing: 0.1em">Qiln</n-text>
                  </n-flex>
                </div>

                <div class="header-center">
                  <n-auto-complete
                    ref="searchRef"
                    class="command-palette"
                    placeholder="Search capsules..."
                    size="small"
                    v-model:value="searchValue"
                    :options="searchOptions"
                    :render-label="renderSearchLabel"
                    :clear-after-select="true"
                    @select="handleSearchSelect"
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
                        <n-avatar
                          round
                          size="small"
                          src="https://i.pravatar.cc/150?img=32"
                          fallback-src="https://i.pravatar.cc/150?img=3" />
                        <icon :path="mdiChevronDown" :size="16" style="opacity: 0.5" />
                      </div>
                    </n-dropdown>
                  </n-flex>
                </div>
              </n-layout-header>

              <n-layout has-sider position="absolute" style="top: 48px; bottom: 0">
                <qiln-rail />
                <qiln-sidebar />
                <n-layout-content
                  native-scrollbar
                  style="border-top: 1px solid rgba(255, 255, 255, 0.08)"
                  content-style="padding: 32px;">
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
  import { navigate } from 'vike/client/router'
  import {
    mdiBellOutline,
    mdiChevronDown,
    mdiCog,
    mdiConsoleLine,
    mdiCubeOutline,
    mdiHome,
    mdiLogout,
    mdiMagnify,
  } from '@mdi/js'
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
  import { Icon } from '@/components/Icon'
  import { transitionBus } from '@/renderer/utils/transitions'
  import { adminThemeOverrides } from '@/renderer/layout/adminThemeOverrides'
  import QilnRail from '@/components/admin/QilnRail.vue'
  import QilnSidebar from '@/components/admin/QilnSidebar.vue'

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

  const handleKeydown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
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

  type SearchOption = AutoCompleteOption & {
    resourceType?: 'capsule' | 'operation'
  }

  const allSearchOptions: AutoCompleteGroupOption[] = [
    {
      type: 'group',
      label: 'Capsules',
      key: 'capsules',
      children: [{ label: 'Capsules', value: '/admin/capsules', resourceType: 'capsule' }] as SearchOption[],
    },
    {
      type: 'group',
      label: 'Operations',
      key: 'operations',
      children: [{ label: 'Operations', value: '/admin/operations', resourceType: 'operation' }] as SearchOption[],
    },
  ]

  const searchOptions = computed(() => {
    if (!searchValue.value) {
      return allSearchOptions
    }

    const query = searchValue.value.toLowerCase()

    return allSearchOptions
      .map(group => {
        const children = (group.children ?? []) as SearchOption[]
        const filteredChildren = children.filter(child =>
          String(child.label ?? '')
            .toLowerCase()
            .includes(query),
        )
        return { ...group, children: filteredChildren }
      })
      .filter(group => group.children.length > 0)
  })

  const renderSearchLabel = (info: SearchOption) => {
    const iconPath = info.resourceType === 'operation' ? mdiConsoleLine : mdiCubeOutline

    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
      h(Icon, { path: iconPath, size: 14, style: { opacity: 0.5 } }),
      h('span', info.label as string),
    ])
  }

  function handleSearchSelect(value: string | number) {
    if (typeof value === 'string' && value.startsWith('/admin/')) {
      navigate(value)
      searchValue.value = ''
    }
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

  function handleUserMenuSelect(key: string | number) {
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
