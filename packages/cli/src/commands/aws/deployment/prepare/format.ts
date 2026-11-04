import { STATE_MOUNTPOINT } from '../../../../host/mount'

interface MountEntry {
  source: string
  fstype: string
  fsroot: string
}

/**
 * The kernel mount-table entry at the state directory, or the absence of one.
 * Shared by the ZFS and Incus host inventories, which read the same table.
 */
export function stateMountText(mount: MountEntry | null): string {
  return mount === null
    ? `nothing reported mounted at ${STATE_MOUNTPOINT}`
    : `${mount.source} · ${mount.fstype} · root ${mount.fsroot} · kernel mount table, read just now`
}
