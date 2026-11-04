import type { IncusAction } from '../../../../host/incus/spec'
import type { StepAction } from '../../../../host/zfs/spec'

/**
 * `short` names the progress row and must fit the row label column (26
 * characters), because `Reporter.row` truncates anything longer. `label` is the
 * full sentence that an approval screen lists.
 */
export interface StepText {
  short: string
  label: string
}

export const ZFS_STEPS: Record<StepAction, StepText> = {
  'install-packages': { short: 'Install ZFS packages', label: 'Install the approved ZFS packages' },
  'write-arc': { short: 'Write ARC limit file', label: 'Write the ZFS ARC limit file' },
  'load-module': { short: 'Load ZFS module', label: 'Load the ZFS kernel module' },
  'apply-arc': { short: 'Apply ARC limit', label: 'Apply the running ZFS ARC limit' },
  'create-pool': { short: 'Create ZFS pool', label: 'Create the ZFS pool' },
  'create-datasets': { short: 'Create ZFS datasets', label: 'Create the state and storage ZFS datasets' },
  'import-pool': { short: 'Import ZFS pool', label: 'Import the ZFS pool' },
  'mount-state': { short: 'Mount state dataset', label: 'Mount the Incus state dataset' },
  'unmount-state': { short: 'Unmount state dataset', label: 'Unmount the Incus state dataset' },
  'export-pool': { short: 'Export ZFS pool', label: 'Export the ZFS pool' },
  'enable-scrub': { short: 'Enable ZFS scrub timer', label: 'Enable the monthly ZFS scrub timer' },
}

export const INCUS_STEPS: Record<IncusAction, StepText> = {
  close: { short: 'Close Incus units', label: 'Mask the Incus units so no package can start them' },
  guard: { short: 'Install startup guard', label: 'Install the storage-identity startup guard' },
  'add-repository': { short: 'Add Zabbly repository', label: 'Add the Zabbly signing key and APT source' },
  'refresh-lists': { short: 'Refresh APT lists', label: 'Refresh APT package lists' },
  'install-packages': { short: 'Install Incus packages', label: 'Install the approved Incus packages' },
  open: { short: 'Open Incus daemon', label: 'Unmask and start the Incus daemon units' },
  initialize: { short: 'Initialize Incus', label: 'Initialize Incus from the approved preseed' },
  'grant-access': {
    short: 'Grant socket access',
    label: 'Add the administrator account to the Incus administration group',
  },
  'stop-workloads': {
    short: 'Stop Incus workloads',
    label: 'Set the Incus instances not to autostart and stop them gracefully',
  },
  release: { short: 'Release Incus', label: 'Mask the Incus units, then stop Incus and release its sockets' },
}
