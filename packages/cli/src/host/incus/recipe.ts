import { createHash } from 'node:crypto'
import { INCUS_SPEC } from './spec'
import { ARTIFACTS_MOUNTPOINT } from '../mount'
import accessScript from './scripts/access.sh?raw'
import artifactsScript from './scripts/artifacts.sh?raw'
import closeScript from './scripts/close.sh?raw'
import guardScript from './scripts/guard.sh?raw'
import initScript from './scripts/init.sh?raw'
import inspectScript from './scripts/inspect.sh?raw'
import installScript from './scripts/install.sh?raw'
import openScript from './scripts/open.sh?raw'
import pinScript from './scripts/pin.sh?raw'
import refreshScript from './scripts/refresh.sh?raw'
import releaseScript from './scripts/release.sh?raw'
import repositoryScript from './scripts/repository.sh?raw'
import startupScript from './scripts/startup.sh?raw'
import workloadsScript from './scripts/workloads.sh?raw'

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Embedded at build time, so they never depend on files beside the executable.
 * The signing key is not embedded: the host downloads it and checks it against
 * the reviewed digest in the spec. The startup check is installed on the host by
 * the guard step, so its bytes are part of the recipe.
 */
export const SCRIPTS = Object.freeze({
  access: accessScript,
  artifacts: artifactsScript,
  close: closeScript,
  guard: guardScript,
  init: initScript,
  inspect: inspectScript,
  install: installScript,
  open: openScript,
  pin: pinScript,
  refresh: refreshScript,
  release: releaseScript,
  repository: repositoryScript,
  startup: startupScript,
  workloads: workloadsScript,
})

/**
 * Identifies the embedded scripts, key coordinates, supported versions, staging
 * directory, artifacts mountpoint, sysctl and guard locations, and recipe
 * revision. It grants no authority.
 */
function digestOf(): string {
  const { recipeRevision, repository, guard, sysctl, versions, stageDirectory } = INCUS_SPEC
  const hash = createHash('sha256').update(
    `revision:${recipeRevision}\0key:${repository.keyUrl}\0${repository.keySha256}\0versions:${versions.minimum}\0${versions.maximumExclusive}\0stage:${stageDirectory}\0artifacts:${ARTIFACTS_MOUNTPOINT}\0sysctl:${sysctl.file}\0${sysctl.key}\0${sysctl.value}\0guard:${guard.expectationFile}\0${guard.checkFile}\0${guard.dropInFile}\0`,
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
