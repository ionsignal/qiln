import type {
  CapsuleBranchStatus,
  CapsuleLifecycleState,
  CapsuleOperationSummary,
  CapsulePreview,
} from '@qiln/core/client'
import type { TagProps } from 'naive-ui'

interface StatePresentation {
  label: string
  tone: NonNullable<TagProps['type']>
}

export const lifecycleStates = {
  provisioning: { label: 'Provisioning', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  archiving: { label: 'Archiving', tone: 'warning' },
  unarchiving: { label: 'Unarchiving', tone: 'info' },
  destroying: { label: 'Destroying', tone: 'warning' },
  destroyed: { label: 'Destroyed', tone: 'default' },
  creation_failed: { label: 'Creation failed', tone: 'error' },
  cleanup_required: { label: 'Cleanup required', tone: 'error' },
} satisfies Record<CapsuleLifecycleState['lifecycleStatus'], StatePresentation>

export const branchStates = {
  provisioning: { label: 'Provisioning', tone: 'info' },
  offline: { label: 'Offline', tone: 'default' },
  snapshotting: { label: 'Creating snapshot', tone: 'info' },
  starting: { label: 'Starting', tone: 'info' },
  online: { label: 'Online', tone: 'success' },
  stopping: { label: 'Stopping', tone: 'warning' },
  destroying: { label: 'Destroying', tone: 'warning' },
  destroyed: { label: 'Destroyed', tone: 'default' },
  error: { label: 'Runtime error', tone: 'error' },
  cleanup_required: { label: 'Cleanup required', tone: 'error' },
} satisfies Record<CapsuleBranchStatus, StatePresentation>

export const previewStates = {
  inactive: { label: 'Inactive', tone: 'default' },
  applying: { label: 'Applying route', tone: 'info' },
  verifying: { label: 'Verifying', tone: 'info' },
  active: { label: 'Verified', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  removing: { label: 'Removing route', tone: 'warning' },
  cleanup_required: { label: 'Cleanup required', tone: 'error' },
} satisfies Record<CapsulePreview['status'], StatePresentation>

export const previewDescriptions = {
  inactive: 'No active preview route.',
  applying: 'Qiln is applying the preview route.',
  verifying: 'Qiln is checking the application and its preview route.',
  active: 'Qiln has recorded successful application and route verification.',
  degraded: 'The preview is degraded and cannot currently be opened.',
  removing: 'Qiln is withdrawing the preview route.',
  cleanup_required: 'The preview requires operator inspection before it can be used.',
} satisfies Record<CapsulePreview['status'], string>

export const operationStates = {
  accepted: { label: 'Accepted', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  cleanup_required: { label: 'Cleanup required', tone: 'error' },
} satisfies Record<CapsuleOperationSummary['status'], StatePresentation>

export const operationLabels = {
  create: 'Create capsule',
  fork: 'Fork branch',
  archive: 'Archive capsule',
  unarchive: 'Unarchive capsule',
  destroy: 'Destroy capsule',
  snapshot_create: 'Create snapshot',
  branch_start: 'Start branch',
  branch_stop: 'Stop branch',
  promote: 'Promote route alias',
  rollback: 'Roll back route alias',
} satisfies Record<CapsuleOperationSummary['type'], string>

/**
 * Routine active lifecycle state adds no attention signal to the overview.
 * Archive state remains independent from lifecycle and runtime state.
 */
export function lifecycleExceptions(capsule: CapsuleLifecycleState): StatePresentation[] {
  const states: StatePresentation[] = []
  if (capsule.lifecycleStatus !== 'active') {
    states.push(lifecycleStates[capsule.lifecycleStatus])
  }
  if (capsule.archivedAt !== null) {
    states.push({ label: 'Archived', tone: 'default' })
  }
  return states
}

/**
 * Explicit UTC formatting keeps server and browser rendering identical.
 */
export function formatTimestamp(value: string): string {
  return `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

export function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

export function applicationLabel(name: string): string {
  return name.toLowerCase() === 'comfyui' ? 'ComfyUI' : name
}

/**
 * Browser links use only Worker-issued URLs. Callers additionally gate opening
 * on their refresh state without rewriting persisted preview status.
 */
export function openablePreviews(previews: CapsulePreview[] | null): Array<CapsulePreview & { previewUrl: string }> {
  return (previews ?? []).filter(
    (preview): preview is CapsulePreview & { previewUrl: string } =>
      preview.status === 'active' && preview.previewUrl !== null,
  )
}

export function previewSummary(previews: CapsulePreview[] | null): StatePresentation {
  if (previews === null) {
    return { label: 'Evidence unavailable', tone: 'default' }
  }
  if (previews.length === 0) {
    return { label: 'No preview records', tone: 'default' }
  }
  if (previews.some(preview => preview.status === 'cleanup_required')) {
    return previewStates.cleanup_required
  }
  if (previews.some(preview => preview.status === 'degraded')) {
    return previewStates.degraded
  }
  const readyCount = openablePreviews(previews).length
  if (readyCount > 0) {
    return {
      label: previews.length === 1 ? 'Ready' : `${readyCount} of ${previews.length} ready`,
      tone: readyCount === previews.length ? 'success' : 'info',
    }
  }
  const first = previews[0]
  if (first && previews.every(preview => preview.status === first.status)) {
    return first.status === 'active' ? { label: 'Verified · no link', tone: 'default' } : previewStates[first.status]
  }
  return { label: 'Not ready', tone: 'default' }
}
