import { computed, h, ref, watch, type VNodeChild } from 'vue'
import { usePageContext } from '@/composables/usePageContext'
import { ALink } from '@/components/ALink'
import { Icon } from '@/components/Icon'
import { NButton, type MenuOption } from 'naive-ui'
import {
  mdiViewDashboard,
  mdiServerNetwork,
  mdiDatabase,
  mdiLan,
  mdiExpansionCard,
  mdiMemory,
  mdiConsoleLine,
  mdiFolder,
  mdiChevronDown,
  mdiChevronRight,
  mdiShieldAccount,
  mdiRouterNetwork,
  mdiCog,
  mdiHistory,
  mdiCubeOutline,
  mdiDotsHorizontal,
  mdiPlus,
  mdiSafe,
  mdiChip,
  mdiPackageVariantClosed,
  mdiProgressClock,
} from '@mdi/js'

export type QilnContext = 'workspace' | 'forge' | 'operations'
export type QilnMenuOption = MenuOption & {
  isCategoryGroup?: boolean
  isDefaultExpanded?: boolean
  isRootAction?: boolean
}

const renderLink = (label: string, href: string) => () => h(ALink, { href, style: 'text-decoration: none;' }, () => label)
const renderIcon = (path: string) => () => h(Icon, { path, size: 14 })

const renderColoredIcon = (path: string, color?: string) => {
  if (!color) return renderIcon(path)
  return () =>
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '20px',
          height: '20px',
          borderRadius: '4px',
          backgroundColor: `${color}cc`,
          color: '#fff',
        },
      },
      [h(Icon, { path, size: 12 })],
    )
}

const renderCategoryLabel = (label: string) => (): VNodeChild =>
  h(
    'div',
    {
      style: {
        fontSize: '0.7rem',
        letterSpacing: '0.05em',
        fontWeight: '600',
        textTransform: 'uppercase',
        color: 'var(--n-group-text-color)',
      },
    },
    label,
  )

const renderQuickProvision =
  (moldId: string): (() => VNodeChild) =>
  () =>
    h(
      NButton,
      {
        class: 'quick-provision-btn',
        style: {
          width: '20px',
          height: '20px',
          minWidth: '20px',
          padding: 0,
          borderRadius: '6px',
        },
        onClick: (e: MouseEvent) => {
          e.stopPropagation()
          e.preventDefault()
          console.log(`Open quick provision modal for ${moldId}`)
        },
      },
      { icon: renderIcon(mdiPlus) },
    )

const renderExpandIcon = (option: MenuOption) => {
  const qilnOption = option as QilnMenuOption
  if (qilnOption.isCategoryGroup) {
    return h(Icon, { path: mdiChevronDown })
  }
  return h(Icon, { path: mdiChevronRight })
}

const menuNodeProps = (option: MenuOption) => {
  const qilnOption = option as QilnMenuOption
  if (qilnOption.isCategoryGroup) {
    return { class: 'qiln-category-header' }
  }
  if (qilnOption.isRootAction) {
    return { class: 'qiln-root-action' }
  }
  return {}
}

export interface PinnedResource {
  id: string
  name: string
  type: 'folder' | 'vessel' | 'vault' | 'gpu'
  url?: string
  iconColor?: string
  children?: PinnedResource[]
  isDefaultExpanded?: boolean
}

function mapPinnedToMenuOptions(resources: PinnedResource[]): QilnMenuOption[] {
  return resources.map(res => {
    let iconPath = mdiFolder
    if (res.type === 'vessel') iconPath = mdiServerNetwork
    if (res.type === 'vault') iconPath = mdiSafe
    if (res.type === 'gpu') iconPath = mdiChip
    const option: QilnMenuOption = {
      key: res.url || res.id,
      label: res.url ? renderLink(res.name, res.url) : res.name,
      icon: renderColoredIcon(iconPath, res.iconColor),
      isDefaultExpanded: res.isDefaultExpanded,
    }
    if (res.children && res.children.length > 0) {
      option.children = mapPinnedToMenuOptions(res.children)
    }
    return option
  })
}

const forgeMenuOptions: QilnMenuOption[] = [
  {
    label: renderLink('Forge Overview', '/admin/forge'),
    key: '/admin/forge',
    icon: renderIcon(mdiViewDashboard),
    isRootAction: true,
  },
  {
    key: 'divider-forge',
    type: 'divider',
    props: { style: 'margin: 12px 18px;' },
  },
  {
    label: renderCategoryLabel('Mold Registry'),
    key: 'group-molds',
    isCategoryGroup: true,
    children: [
      {
        label: renderLink('vLLM Inference', '/admin/molds/vllm'),
        key: '/admin/molds/vllm',
        icon: renderIcon(mdiCubeOutline),
        extra: renderQuickProvision('vllm'),
      },
      {
        label: renderLink('ComfyUI Workspace', '/admin/molds/comfyui'),
        key: '/admin/molds/comfyui',
        icon: renderIcon(mdiCubeOutline),
        extra: renderQuickProvision('comfyui'),
      },
      {
        label: renderLink('Jupyter Research', '/admin/molds/jupyter'),
        key: '/admin/molds/jupyter',
        icon: renderIcon(mdiCubeOutline),
        extra: renderQuickProvision('jupyter'),
      },
      {
        label: renderLink('More', '/admin/molds'),
        key: '/admin/molds',
        icon: renderIcon(mdiDotsHorizontal),
      },
    ],
  },
  {
    label: renderCategoryLabel('Image Press'),
    key: 'group-images',
    isCategoryGroup: true,
    children: [
      {
        label: renderLink('Published Images', '/admin/images'),
        key: '/admin/images',
        icon: renderIcon(mdiPackageVariantClosed),
      },
      {
        label: renderLink('Build Queue', '/admin/images/builds'),
        key: '/admin/images/builds',
        icon: renderIcon(mdiProgressClock),
      },
    ],
  },
  {
    label: renderCategoryLabel('Fleet & Shared Vaults'),
    key: 'group-fleet',
    isCategoryGroup: true,
    children: [
      {
        label: renderLink('All Vessels (Global)', '/admin/fleet'),
        key: '/admin/fleet',
        icon: renderIcon(mdiServerNetwork),
      },
      {
        label: renderLink('Global Vaults', '/admin/vaults'),
        key: '/admin/vaults',
        icon: renderIcon(mdiSafe),
      },
    ],
  },
  {
    label: renderCategoryLabel('Tenant Management'),
    key: 'group-tenants',
    isCategoryGroup: true,
    children: [
      {
        label: renderLink('Tenants & Quotas', '/admin/tenants'),
        key: '/admin/tenants',
        icon: renderIcon(mdiShieldAccount),
      },
    ],
  },
  {
    label: renderCategoryLabel('Infrastructure'),
    key: 'group-infrastructure',
    isCategoryGroup: true,
    children: [
      {
        label: renderLink('GPU Pool', '/admin/gpus'),
        key: '/admin/gpus',
        icon: renderIcon(mdiExpansionCard),
      },
      {
        label: renderLink('Gateway (Proxy)', '/admin/gateway'),
        key: '/admin/gateway',
        icon: renderIcon(mdiRouterNetwork),
      },
      {
        label: renderLink('Network (Internal)', '/admin/network'),
        key: '/admin/network',
        icon: renderIcon(mdiLan),
      },
      {
        label: renderLink('Storage Pools', '/admin/storage'),
        key: '/admin/storage',
        icon: renderIcon(mdiDatabase),
      },
      {
        label: renderLink('Cluster Nodes', '/admin/host'),
        key: '/admin/host',
        icon: renderIcon(mdiMemory),
      },
    ],
  },
]

const operationsMenuOptions: QilnMenuOption[] = [
  {
    label: renderLink('Operations Center', '/admin/operations'),
    key: '/admin/operations',
    icon: renderIcon(mdiViewDashboard),
    isRootAction: true,
  },
  {
    key: 'divider-ops',
    type: 'divider',
    props: { style: 'margin: 12px 18px;' },
  },
  {
    label: renderCategoryLabel('Operations'),
    key: 'group-operations',
    isCategoryGroup: true,
    children: [
      {
        label: renderLink('Alerts & Audit Log', '/admin/audit'),
        key: '/admin/audit',
        icon: renderIcon(mdiHistory),
      },
      {
        label: renderLink('Event Stream', '/admin/events'),
        key: '/admin/events',
        icon: renderIcon(mdiConsoleLine),
      },
      {
        label: renderLink('Settings', '/admin/settings'),
        key: '/admin/settings',
        icon: renderIcon(mdiCog),
      },
    ],
  },
]

const extractKeysByFlag = (options: QilnMenuOption[], flag: keyof QilnMenuOption): string[] => {
  const keys: string[] = []
  for (const opt of options) {
    if (opt[flag] && opt.key) keys.push(opt.key as string)
    if (opt.children) keys.push(...extractKeysByFlag(opt.children as QilnMenuOption[], flag))
  }
  return keys
}

const findPathToKey = (options: QilnMenuOption[], targetKey: string | null): string[] | null => {
  if (!targetKey) return null
  for (const opt of options) {
    if (opt.key === targetKey) return []
    if (opt.children) {
      const path = findPathToKey(opt.children as QilnMenuOption[], targetKey)
      if (path !== null) {
        if (opt.key) path.unshift(opt.key as string)
        return path
      }
    }
  }
  return null
}

export function useQilnNavigation() {
  const mockPinnedData = ref<PinnedResource[]>([
    {
      id: 'folder-prod',
      name: 'Production',
      type: 'folder',
      iconColor: '#10b981',
      isDefaultExpanded: true,
      children: [
        { id: 'prod-vllm-01', name: 'prod-vllm-01', type: 'vessel', url: '/admin/vessels/prod-vllm-01', iconColor: '#6366f1' },
        { id: 'auth-db-01', name: 'auth-db-01', type: 'vessel', url: '/admin/vessels/auth-db-01', iconColor: '#f59e0b' },
      ],
    },
    {
      id: 'folder-vaults',
      name: 'Core Vaults',
      type: 'folder',
      iconColor: '#8b5cf6',
      isDefaultExpanded: true,
      children: [{ id: 'is-model-vault', name: 'is-model-vault', type: 'vault', url: '/admin/vaults/is-model-vault', iconColor: '#ec4899' }],
    },
  ])
  const workspaceMenuOptions = computed<QilnMenuOption[]>(() => [
    {
      label: renderLink('My Vessels', '/admin/workspace/vessels'),
      key: '/admin/workspace/vessels',
      icon: renderIcon(mdiServerNetwork),
      isRootAction: true,
    },
    {
      label: renderLink('My Vaults', '/admin/workspace/vaults'),
      key: '/admin/workspace/vaults',
      icon: renderIcon(mdiSafe),
      isRootAction: true,
    },
    {
      key: 'divider-ws-pinned',
      type: 'divider',
      props: { style: 'margin: 12px 18px;' },
    },
    {
      label: renderCategoryLabel('Pinned Resources'),
      key: 'group-pinned',
      isCategoryGroup: true,
      children: mapPinnedToMenuOptions(mockPinnedData.value),
    },
  ])
  const pageContext = usePageContext()
  const activeContext = computed<QilnContext>(() => {
    const path = pageContext.value.urlPathname || ''
    if (
      path.startsWith('/admin/operations') ||
      path.startsWith('/admin/audit') ||
      path.startsWith('/admin/events') ||
      path.startsWith('/admin/settings')
    ) {
      return 'operations'
    }
    if (
      path.startsWith('/admin/forge') ||
      path.startsWith('/admin/molds') ||
      path.startsWith('/admin/fleet') ||
      path.startsWith('/admin/images') ||
      path.startsWith('/admin/tenants') ||
      path.startsWith('/admin/gpus') ||
      path.startsWith('/admin/gateway') ||
      path.startsWith('/admin/network') ||
      path.startsWith('/admin/storage') ||
      path.startsWith('/admin/host')
    ) {
      return 'forge'
    }
    return 'workspace'
  })

  const currentMenuTree = computed<QilnMenuOption[]>(() => {
    switch (activeContext.value) {
      case 'forge':
        return forgeMenuOptions
      case 'operations':
        return operationsMenuOptions
      case 'workspace':
      default:
        return workspaceMenuOptions.value
    }
  })

  const isPinned = (id: string) => {
    const check = (resources: PinnedResource[]): boolean => {
      for (const res of resources) {
        if (res.id === id) return true
        if (res.children && check(res.children)) return true
      }
      return false
    }
    return check(mockPinnedData.value)
  }

  const togglePin = (resource: PinnedResource) => {
    if (isPinned(resource.id)) {
      const remove = (resources: PinnedResource[]): PinnedResource[] => {
        return resources.filter(r => r.id !== resource.id).map(r => ({ ...r, children: r.children ? remove(r.children) : undefined }))
      }
      mockPinnedData.value = remove(mockPinnedData.value)
    } else {
      mockPinnedData.value.push(resource)
    }
  }

  const activeMenuKey = computed<string | null>(() => {
    const path = pageContext.value.urlPathname || ''
    if (path === '/admin/workspace/vessels') return '/admin/workspace/vessels'
    if (path === '/admin/workspace/vaults') return '/admin/workspace/vaults'
    if (path === '/admin/forge') return '/admin/forge'
    if (path === '/admin/operations') return '/admin/operations'
    const findUrl = (resources: PinnedResource[]): boolean => {
      for (const res of resources) {
        if (res.url === path) return true
        if (res.children && findUrl(res.children)) return true
      }
      return false
    }
    if (activeContext.value === 'workspace' && findUrl(mockPinnedData.value)) {
      return path
    }
    const keys = [
      '/admin/workspace/vessels',
      '/admin/workspace/vaults',
      '/admin/forge',
      '/admin/operations',
      '/admin/leases',
      '/admin/molds',
      '/admin/images/builds',
      '/admin/images',
      '/admin/fleet',
      '/admin/vaults',
      '/admin/tenants',
      '/admin/gpus',
      '/admin/gateway',
      '/admin/network',
      '/admin/storage',
      '/admin/host',
      '/admin/audit',
      '/admin/events',
      '/admin/settings',
    ]
    const sorted = keys.sort((a, b) => b.length - a.length)
    for (const key of sorted) {
      if (path.startsWith(key)) return key
    }
    return null
  })

  const immutableKeys = computed(() => extractKeysByFlag(currentMenuTree.value, 'isCategoryGroup'))
  const activePathKeys = computed(() => findPathToKey(currentMenuTree.value, activeMenuKey.value) || [])
  const userExpandedKeys = ref<string[]>([])

  watch(
    currentMenuTree,
    tree => {
      userExpandedKeys.value = extractKeysByFlag(tree, 'isDefaultExpanded')
    },
    { immediate: true },
  )

  const resolvedExpandedKeys = computed(() => {
    return Array.from(new Set([...immutableKeys.value, ...activePathKeys.value, ...userExpandedKeys.value]))
  })

  const handleExpandedKeysChange = (keys: string[]) => {
    userExpandedKeys.value = keys
  }

  return {
    activeContext,
    currentMenuTree,
    activeMenuKey,
    resolvedExpandedKeys,
    handleExpandedKeysChange,
    renderExpandIcon,
    menuNodeProps,
    isPinned,
    togglePin,
  }
}
