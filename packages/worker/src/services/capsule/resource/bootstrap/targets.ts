import path from 'node:path'

export interface AttachedVolume {
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
 * Evaluates a file path against a sorted list of attached volumes to determine
 * whether provisioning should target an offline custom volume or the instance
 * rootfs. Blueprint validation separately determines whether writes are
 * allowed.
 */
export function resolveFileTarget(filePath: string, attachedVolumes: AttachedVolume[]): ProvisioningFileTarget {
  const normalizedFilePath = path.posix.normalize(filePath)
  for (const volume of attachedVolumes) {
    const normalizedMountPath = path.posix.normalize(volume.mountPath)
    const relativePath = path.posix.relative(normalizedMountPath, normalizedFilePath)
    if (
      relativePath === '' ||
      (relativePath !== '..' && !relativePath.startsWith('../') && !path.posix.isAbsolute(relativePath))
    ) {
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
