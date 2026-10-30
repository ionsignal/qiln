import { createHash } from 'node:crypto'
import { ZFS_SPEC } from './spec'
import arcScript from './scripts/arc.sh?raw'
import createScript from './scripts/create.sh?raw'
import datasetsScript from './scripts/datasets.sh?raw'
import exportScript from './scripts/export.sh?raw'
import importScript from './scripts/import.sh?raw'
import inspectScript from './scripts/inspect.sh?raw'
import moduleScript from './scripts/module.sh?raw'
import packagesScript from '../scripts/packages.sh?raw'
import scrubScript from './scripts/scrub.sh?raw'
import stateScript from './scripts/state.sh?raw'

/**
 * Scripts are embedded at build time, so they never depend on files beside the
 * installed executable.
 */
export const SCRIPTS = Object.freeze({
  arc: arcScript,
  create: createScript,
  datasets: datasetsScript,
  export: exportScript,
  import: importScript,
  inspect: inspectScript,
  module: moduleScript,
  packages: packagesScript,
  scrub: scrubScript,
  state: stateScript,
})

/**
 * Identifies the exact embedded scripts and the recipe revision. It identifies
 * implementation bytes and grants no authority.
 */
function digestOf(): string {
  const hash = createHash('sha256').update(`revision:${ZFS_SPEC.recipeRevision}\0`)
  const scripts = Object.entries(SCRIPTS).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  for (const [name, text] of scripts) {
    hash.update(`${name}\0${text}\0`)
  }
  return hash.digest('hex')
}

export const RECIPE = Object.freeze({
  revision: ZFS_SPEC.recipeRevision,
  digest: digestOf(),
})
