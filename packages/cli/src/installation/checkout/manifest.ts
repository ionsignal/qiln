import { createHash } from 'node:crypto'
import captureScript from './scripts/capture.sh?raw'
import materializeScript from './scripts/materialize.sh?raw'
import resolveScript from './scripts/resolve.sh?raw'

/**
 * Scripts are embedded at build time, so they never depend on files beside the
 * installed executable.
 */
export const CHECKOUT_SCRIPTS = Object.freeze({
  capture: captureScript,
  materialize: materializeScript,
  resolve: resolveScript,
})

/**
 * Identifies the exact embedded scripts. It is an input of the installation
 * recipe digest, identifies implementation bytes, and grants no authority.
 */
function digestOf(): string {
  const hash = createHash('sha256')
  const scripts = Object.entries(CHECKOUT_SCRIPTS).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  for (const [name, text] of scripts) {
    hash.update(`${name}\0${text}\0`)
  }
  return hash.digest('hex')
}

export const CHECKOUT_DIGEST = digestOf()
