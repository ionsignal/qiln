import path from 'node:path'

export interface ManagedVolume {
  pool: string
  volumeName: string
  mountPath: string
}

export type ProvisioningFileTarget =
  | {
      target: 'volume'
      pool: string
      volumeName: string
      internalPath: string
    }
  | {
      target: 'instance'
    }

/**
 * Evaluates a file path against a sorted list of managed volumes to determine
 * whether provisioning should target an offline custom volume or the instance rootfs.
 */
export function resolveFileTarget(filePath: string, managedVolumes: ManagedVolume[]): ProvisioningFileTarget {
  const normalizedFilePath = path.posix.normalize(filePath)
  for (const volume of managedVolumes) {
    const normalizedMountPath = path.posix.normalize(volume.mountPath)
    const relativePath = path.posix.relative(normalizedMountPath, normalizedFilePath)
    if (relativePath === '' || (!relativePath.startsWith('..') && !path.posix.isAbsolute(relativePath))) {
      return {
        target: 'volume',
        pool: volume.pool,
        volumeName: volume.volumeName,
        internalPath: path.posix.join('/', relativePath),
      }
    }
  }
  return { target: 'instance' }
}
