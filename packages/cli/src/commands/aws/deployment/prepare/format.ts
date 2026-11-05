import { STATE_MOUNTPOINT } from '../../../../host/mount'

interface MountEntry {
  source: string
  fstype: string
  fsroot: string
}

export function mountText(mount: MountEntry | null, path: string): string {
  return mount === null
    ? `nothing reported mounted at ${path}`
    : `${mount.source} · ${mount.fstype} · root ${mount.fsroot} · kernel mount table, read just now`
}

export function stateMountText(mount: MountEntry | null): string {
  return mountText(mount, STATE_MOUNTPOINT)
}
