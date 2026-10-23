import type { BlockDevice } from './types'

const EBS_SERIAL = /^vol-?([0-9a-f]+)$/i

/**
 * EC2 NVMe serials print the volume ID without its hyphen. Only that
 * documented difference is normalized.
 */
function volumeIdOf(serial: string | null): string | null {
  const match = serial === null ? null : EBS_SERIAL.exec(serial)
  return match === null ? null : `vol-${match[1].toLowerCase()}`
}

/**
 * The one top-level disk whose serial names the volume, or null when it is
 * missing or ambiguous.
 */
export function diskOf(disks: readonly BlockDevice[], volumeId: string): BlockDevice | null {
  const matches = disks.filter(disk => disk.type === 'disk' && volumeIdOf(disk.serial) === volumeId)
  return matches.length === 1 ? matches[0] : null
}

/**
 * A device and everything layered on it, such as the partitions ZFS creates on
 * a whole disk.
 */
export function layers(device: BlockDevice): BlockDevice[] {
  return [device, ...device.children.flatMap(layers)]
}

/**
 * The one ZFS member partition of a whole disk. ZFS writes its labels there,
 * so import discovery must target it rather than the parent disk. Zero or
 * several members is ambiguous and yields null.
 */
export function memberOf(disk: BlockDevice): BlockDevice | null {
  const members = disk.children.filter(child => child.type === 'part' && child.filesystem === 'zfs_member')
  return members.length === 1 ? (members[0] ?? null) : null
}
