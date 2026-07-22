import type { ProvisioningFileTarget } from './bootstrap/targets'

function encodeResourceKeySegment(value: string): string {
  return encodeURIComponent(value)
}

export function branchVolumeName(branchName: string, volumeName: string): string {
  return `${branchName}-${volumeName}`
}

export function projectResourceKey(namespace: string): string {
  return `incus:project:${namespace}`
}

export function instanceResourceKey(namespace: string, instanceName: string): string {
  return `incus:instance:${namespace}:${instanceName}`
}

export function volumeResourceKey(namespace: string, pool: string, volumeName: string): string {
  return `incus:storage-volume:${namespace}:${pool}:${volumeName}`
}

export function bindMountResourceKey(namespace: string, hostPath: string, mountPath: string): string {
  return `incus:bind-mount:${namespace}:${hostPath}:${mountPath}`
}

export function provisioningFileResourceKey(
  namespace: string,
  branchName: string,
  filePath: string,
  target: ProvisioningFileTarget,
): string {
  if (target.target === 'volume') {
    return [
      'incus',
      'provisioning-file',
      encodeResourceKeySegment(namespace),
      'volume',
      encodeResourceKeySegment(target.pool),
      encodeResourceKeySegment(target.volumeName),
      encodeResourceKeySegment(target.internalPath),
    ].join(':')
  }

  return [
    'incus',
    'provisioning-file',
    encodeResourceKeySegment(namespace),
    'instance',
    encodeResourceKeySegment(branchName),
    encodeResourceKeySegment(filePath),
  ].join(':')
}
