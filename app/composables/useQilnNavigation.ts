import { computed, h, ref, watch, type VNodeChild } from 'vue'
import { NText, type MenuOption } from 'naive-ui'
import {
  mdiCameraIris,
  mdiChevronDown,
  mdiChevronRight,
  mdiCog,
  mdiConsoleLine,
  mdiHistory,
  mdiProgressClock,
  mdiRouterNetwork,
  mdiViewDashboard,
} from '@mdi/js'
import { usePageContext } from '@/composables/usePageContext'
import { ALink } from '@/components/ALink'
import { Icon } from '@/components/Icon'

export type QilnContext = 'capsules' | 'operations'
export type QilnMenuOption = MenuOption & {
  isCategoryGroup?: boolean
  isDefaultExpanded?: boolean
  isRootAction?: boolean
}

const renderLink = (label: string, href: string) => () =>
  h(ALink, { href, style: 'text-decoration: none;' }, () => label)
const renderIcon = (path: string) => () => h(Icon, { path, size: 14 })

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

const renderComingSoonLabel = (label: string) => (): VNodeChild =>
  h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        width: '100%',
      },
    },
    [
      h('span', label),
      h(
        NText,
        {
          depth: 3,
          style: {
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          },
        },
        () => 'soon',
      ),
    ],
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

const capsuleMenuOptions: QilnMenuOption[] = [
  {
    label: renderLink('Capsules', '/admin/capsules'),
    key: '/admin/capsules',
    icon: renderIcon(mdiViewDashboard),
    isRootAction: true,
  },
  {
    key: 'divider-capsules',
    type: 'divider',
    props: { style: 'margin: 12px 18px;' },
  },
  {
    label: renderCategoryLabel('Capsule Lifecycle'),
    key: 'group-capsule-lifecycle',
    isCategoryGroup: true,
    isDefaultExpanded: true,
    children: [
      {
        label: renderComingSoonLabel('Snapshots'),
        key: 'future-snapshots',
        disabled: true,
        icon: renderIcon(mdiCameraIris),
      },
      {
        label: renderComingSoonLabel('Golden Tests'),
        key: 'future-golden-tests',
        disabled: true,
        icon: renderIcon(mdiProgressClock),
      },
      {
        label: renderComingSoonLabel('Diff Review'),
        key: 'future-diff-review',
        disabled: true,
        icon: renderIcon(mdiHistory),
      },
      {
        label: renderComingSoonLabel('Route Aliases'),
        key: 'future-route-aliases',
        disabled: true,
        icon: renderIcon(mdiRouterNetwork),
      },
    ],
  },
]

const operationsMenuOptions: QilnMenuOption[] = [
  {
    label: renderLink('Operations', '/admin/operations'),
    key: '/admin/operations',
    icon: renderIcon(mdiConsoleLine),
    isRootAction: true,
  },
  {
    key: 'divider-operations',
    type: 'divider',
    props: { style: 'margin: 12px 18px;' },
  },
  {
    label: renderCategoryLabel('Capsule Operations'),
    key: 'group-capsule-operations',
    isCategoryGroup: true,
    isDefaultExpanded: true,
    children: [
      {
        label: renderComingSoonLabel('Audit Log'),
        key: 'future-audit-log',
        disabled: true,
        icon: renderIcon(mdiHistory),
      },
      {
        label: renderComingSoonLabel('Event Stream'),
        key: 'future-event-stream',
        disabled: true,
        icon: renderIcon(mdiConsoleLine),
      },
      {
        label: renderComingSoonLabel('Promotion Settings'),
        key: 'future-promotion-settings',
        disabled: true,
        icon: renderIcon(mdiCog),
      },
    ],
  },
]

const extractKeysByFlag = (options: QilnMenuOption[], flag: keyof QilnMenuOption): string[] => {
  const keys: string[] = []
  for (const option of options) {
    if (option[flag] && typeof option.key === 'string') {
      keys.push(option.key)
    }

    if (option.children) {
      keys.push(...extractKeysByFlag(option.children as QilnMenuOption[], flag))
    }
  }
  return keys
}

const findPathToKey = (options: QilnMenuOption[], targetKey: string | null): string[] | null => {
  if (!targetKey) {
    return null
  }
  for (const option of options) {
    if (option.key === targetKey) {
      return []
    }
    if (option.children) {
      const path = findPathToKey(option.children as QilnMenuOption[], targetKey)
      if (path !== null) {
        if (typeof option.key === 'string') {
          path.unshift(option.key)
        }
        return path
      }
    }
  }
  return null
}

export function useQilnNavigation() {
  const pageContext = usePageContext()
  const activeContext = computed<QilnContext>(() => {
    const path = pageContext.value.urlPathname || ''
    if (path.startsWith('/admin/operations')) {
      return 'operations'
    }
    return 'capsules'
  })

  const currentMenuTree = computed<QilnMenuOption[]>(() => {
    if (activeContext.value === 'operations') {
      return operationsMenuOptions
    }
    return capsuleMenuOptions
  })

  const activeMenuKey = computed<string>(() => {
    const path = pageContext.value.urlPathname || ''
    if (path.startsWith('/admin/operations')) {
      return '/admin/operations'
    }
    return '/admin/capsules'
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

  const handleExpandedKeysChange = (keys: Array<string | number>) => {
    userExpandedKeys.value = keys.map(key => String(key))
  }

  return {
    activeContext,
    currentMenuTree,
    activeMenuKey,
    resolvedExpandedKeys,
    handleExpandedKeysChange,
    renderExpandIcon,
    menuNodeProps,
  }
}
