import { IncusError } from '../../../errors'
import type { ProvisioningFileTarget } from './bootstrap/targets'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_INCUS_IDENTITY_LENGTH = 255

function encodeResourceKeySegment(value: string): string {
  return encodeURIComponent(value)
}

function branchProviderPrefix(branchId: string): string {
  if (!UUID_PATTERN.test(branchId)) {
    throw new IncusError('Capsule branch provider identity requires a valid branch UUID.', 'VALIDATION_ERROR', {
      branchId,
    })
  }
  return `qiln-${branchId.toLowerCase()}`
}

/**
 * Derives the Incus instance identity from the durable branch UUID.
 *
 * User-facing branch names are scoped to one capsule and therefore cannot be
 * reused as owner-wide Incus project identities.
 */
export function branchInstanceName(branchId: string): string {
  return branchProviderPrefix(branchId)
}

/**
 * Derives one managed Incus volume identity from the durable branch UUID and
 * stable Blueprint volume identity.
 */
export function branchVolumeName(branchId: string, volumeName: string): string {
  const name = `${branchProviderPrefix(branchId)}-${volumeName}`
  if (name.length > MAX_INCUS_IDENTITY_LENGTH) {
    throw new IncusError('Generated capsule branch volume identity is too long.', 'VALIDATION_ERROR', {
      branchId,
      volumeName,
      length: name.length,
      maxLength: MAX_INCUS_IDENTITY_LENGTH,
    })
  }
  return name
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
  instanceName: string,
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
    encodeResourceKeySegment(instanceName),
    encodeResourceKeySegment(filePath),
  ].join(':')
}
