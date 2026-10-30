import { createHash } from 'node:crypto'
import { INCUS_SPEC } from './spec'
import accessScript from './scripts/access.sh?raw'
import closeScript from './scripts/close.sh?raw'
import guardScript from './scripts/guard.sh?raw'
import initScript from './scripts/init.sh?raw'
import inspectScript from './scripts/inspect.sh?raw'
import openScript from './scripts/open.sh?raw'
import refreshScript from './scripts/refresh.sh?raw'
import releaseScript from './scripts/release.sh?raw'
import packagesScript from '../scripts/packages.sh?raw'
import repositoryScript from './scripts/repository.sh?raw'
import startupScript from './scripts/startup.sh?raw'
import workloadsScript from './scripts/workloads.sh?raw'

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Scripts are embedded at build time, so they never depend on files beside the
 * installed executable. The signing key is not embedded: the host downloads it
 * and checks it against the reviewed digest in the spec. The package script is
 * shared with ZFS preparation: it is generic over approved `name=version` words.
 * The startup check is installed on the host by the guard step, so its bytes are
 * part of the recipe like any other script.
 */
export const SCRIPTS = Object.freeze({
  access: accessScript,
  close: closeScript,
  guard: guardScript,
  init: initScript,
  inspect: inspectScript,
  open: openScript,
  packages: packagesScript,
  refresh: refreshScript,
  release: releaseScript,
  repository: repositoryScript,
  startup: startupScript,
  workloads: workloadsScript,
})

/**
 * Identifies the exact embedded scripts, the reviewed key coordinates, the
 * sysctl override and guard file locations, and the recipe revision. It
 * identifies implementation bytes and grants no authority.
 */
function digestOf(): string {
  const { recipeRevision, repository, guard, sysctl } = INCUS_SPEC
  const hash = createHash('sha256').update(
    `revision:${recipeRevision}\0key:${repository.keyUrl}\0${repository.keySha256}\0sysctl:${sysctl.file}\0${sysctl.key}\0${sysctl.value}\0guard:${guard.expectationFile}\0${guard.checkFile}\0${guard.dropInFile}\0`,
  )
  const scripts = Object.entries(SCRIPTS).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  for (const [name, text] of scripts) {
    hash.update(`${name}\0${text}\0`)
  }
  return hash.digest('hex')
}

export const RECIPE = Object.freeze({
  revision: INCUS_SPEC.recipeRevision,
  digest: digestOf(),
})
