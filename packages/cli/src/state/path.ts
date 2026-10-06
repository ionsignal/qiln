import { resolve } from 'node:path'
import { InstallerError } from '../diagnostic/error'

export function statePath(environment: NodeJS.ProcessEnv = process.env, retry = 'qiln doctor'): string {
  const configuredStateHome = environment.XDG_STATE_HOME?.trim()
  if (configuredStateHome) {
    if (!configuredStateHome.startsWith('/')) {
      throw new InstallerError({
        code: 'INVALID_STATE_HOME',
        facts: [['Observed', 'XDG_STATE_HOME is set to a relative path.']],
        retry,
      })
    }
    return resolve(configuredStateHome, 'qiln')
  }
  const home = environment.HOME?.trim()
  if (!home || !home.startsWith('/')) {
    throw new InstallerError({
      code: 'MISSING_HOME',
      facts: [['Observed', 'HOME is missing, empty, or relative.']],
      retry,
    })
  }
  return resolve(home, '.local/state/qiln')
}
