import { reactive, provide, inject, watch, type InjectionKey } from 'vue'
import { usePageContext } from '@/composables/usePageContext'
import type { TreeOption } from 'naive-ui'

export interface VaultSidebarState {
  active: boolean
  vaultId: string
  vaultName: string
  directoryTree: TreeOption[]
  activePath: string
  expandedKeys: string[]
  onNavigate: (keys: Array<string | number>) => void
  onExpandChange: (keys: Array<string | number>) => void
  reset: () => void
}

const VaultSidebarKey: InjectionKey<VaultSidebarState> = Symbol('VaultSidebar')

/**
 * Provides the reactive bridge state for the Vault Sidebar.
 * Must be called at the layout level (LayoutQiln) to persist across page navigations.
 */
export function provideVaultSidebar(): VaultSidebarState {
  const pageContext = usePageContext()
  const path = pageContext.value.urlPathname || ''
  const isVaultUrl = path.startsWith('/admin/workspace/vaults/')
  const params = pageContext.value.routeParams || {}
  const initialVaultId = isVaultUrl ? params.vaultId || '' : ''
  const state = reactive<VaultSidebarState>({
    active: isVaultUrl && initialVaultId !== '',
    vaultId: initialVaultId,
    vaultName: initialVaultId,
    directoryTree: [],
    activePath: '/',
    expandedKeys: [],
    onNavigate: () => {},
    onExpandChange: () => {},
    reset() {
      this.active = false
      this.vaultId = ''
      this.vaultName = ''
      this.directoryTree = []
      this.activePath = '/'
      this.expandedKeys = []
      this.onNavigate = () => {}
      this.onExpandChange = () => {}
    },
  })
  watch(
    () => pageContext.value.urlPathname,
    newPath => {
      const isVaultUrl = !!newPath && newPath.startsWith('/admin/workspace/vaults/')
      if (isVaultUrl) {
        state.active = true
      } else {
        state.reset()
      }
    },
  )
  provide(VaultSidebarKey, state)
  return state
}

/**
 * Injects the Vault Sidebar state.
 * Returns a safe fallback if used outside the provider (e.g., isolated component testing).
 */
export function injectVaultSidebar(): VaultSidebarState {
  const state = inject(VaultSidebarKey)
  if (!state) {
    return {
      active: false,
      vaultId: '',
      vaultName: '',
      directoryTree: [],
      activePath: '/',
      expandedKeys: [],
      onNavigate: () => {},
      onExpandChange: () => {},
      reset: () => {},
    }
  }
  return state
}
