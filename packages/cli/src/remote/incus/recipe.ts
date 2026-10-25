import { createHash } from 'node:crypto'
import { INCUS_SPEC } from './spec'
import initScript from './scripts/init.sh?raw'
import inspectScript from './scripts/inspect.sh?raw'
import refreshScript from './scripts/refresh.sh?raw'
import releaseScript from './scripts/release.sh?raw'
import packagesScript from '../scripts/packages.sh?raw'
import repositoryScript from './scripts/repository.sh?raw'

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Scripts are embedded at build time, so they never depend on files beside the
 * installed executable. The signing key is not embedded: the host downloads it
 * and checks it against the reviewed digest in the spec. The package script is
 * shared with ZFS preparation: it is generic over approved `name=version` words.
 */
export const SCRIPTS = Object.freeze({
  init: initScript,
  inspect: inspectScript,
  packages: packagesScript,
  refresh: refreshScript,
  release: releaseScript,
  repository: repositoryScript,
})

/**
 * Identifies the exact embedded scripts, the reviewed key coordinates, and the
 * recipe revision. It identifies implementation bytes and grants no authority.
 */
function digestOf(): string {
  const { recipeRevision, repository } = INCUS_SPEC
  const hash = createHash('sha256').update(`revision:${recipeRevision}\0key:${repository.keyUrl}\0${repository.keySha256}\0`)
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
