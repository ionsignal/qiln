import { InstallerError } from '../diagnostic/error'

export function currentUserId(): number {
  if (typeof process.geteuid !== 'function') {
    throw new InstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      facts: [['Observed', `Node platform '${process.platform}' does not expose process.geteuid().`]],
    })
  }
  return process.geteuid()
}
