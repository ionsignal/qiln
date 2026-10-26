import { InstallerError } from '../diagnostic/error'
import { currentUserId } from '../state/user'

/**
 * AWS commands run on Linux or macOS as an unprivileged operator. This module
 * is a leaf so that every AWS module can establish host and identity without
 * importing connection state.
 */
export function requireAwsHost(): void {
  if (
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    throw new InstallerError({
      code: 'AWS_PLATFORM_UNSUPPORTED',
    })
  }
  if (process.getuid() === 0 || process.geteuid() === 0) {
    throw new InstallerError({
      code: 'ROOT_EXECUTION_REFUSED',
      retry: 'qiln aws connect',
    })
  }
}

export function userId(): number {
  requireAwsHost()
  return currentUserId()
}

