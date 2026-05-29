// packages/qiln-engine/src/utils/menuUtils.ts
import { h } from 'vue'
import { Icon } from '../components/Icon'
import { mdiFolder } from '@mdi/js'
import { joinPath } from './fileUtils'
import type { TreeOption } from 'naive-ui'
import type { MockFsNode } from '../types'

/**
 * Recursively builds a TreeOption[] structure from a MockFsNode dictionary.
 * Strictly filters out files, ensuring only directories are rendered in the tree.
 * Used to map filesystem data to Naive UI's n-tree component.
 */
export function buildDirectoryTreeOptions(node: MockFsNode, currentPath: string): TreeOption[] {
  if (!node.children) return []
  const options: TreeOption[] = []
  for (const [name, child] of Object.entries(node.children)) {
    if (child.type === 'directory') {
      const fullPath = joinPath(currentPath, name)
      const hasDirectoryChildren = child.children && Object.values(child.children).some(c => c.type === 'directory')
      options.push({
        key: fullPath,
        label: name,
        prefix: () => h(Icon, { path: mdiFolder, size: 16, style: 'color: #3b82f6; opacity: 0.8;' }),
        children: hasDirectoryChildren ? buildDirectoryTreeOptions(child, fullPath) : undefined,
      })
    }
  }
  return options.sort((a, b) => (a.label as string).localeCompare(b.label as string))
}
