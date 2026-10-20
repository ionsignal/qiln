import { InstallerError } from '../../../diagnostic/error'
import { isFingerprint } from '../../../ssh/key'

const MAXIMUM_ENCODED_CHARACTERS = 262_144
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const BEGIN = '-----BEGIN SSH HOST KEY FINGERPRINTS-----'
const END = '-----END SSH HOST KEY FINGERPRINTS-----'
// The line may carry a log prefix. The format is unverified for this AMI until the walkthrough.
const ENTRY = /\b256 SHA256:([A-Za-z0-9+/]{43}) .*\(ED25519\)\s*$/

function unverified(): never {
  throw new InstallerError({
    code: 'AWS_DEPLOYMENT_HOST_KEY_UNVERIFIED',
  })
}

/**
 * The SDK returns the console output base64-encoded. It is decoded once, and
 * anything that is not strict, bounded base64 is an error, never a guess.
 */
function decode(output: string): string {
  if (output.length > MAXIMUM_ENCODED_CHARACTERS || output.length % 4 !== 0 || !BASE64.test(output)) {
    return unverified()
  }
  const bytes = Buffer.from(output, 'base64')
  return bytes.toString('base64') === output ? bytes.toString('utf8') : unverified()
}

/**
 * Extracts the one Ed25519 host-key fingerprint from console output, or null
 * when none is complete yet. Only complete host-key blocks are read, so the
 * authorized-key fingerprints listed elsewhere are never mistaken for the host
 * key. Identical repetitions are one fingerprint, and conflicting ones are an
 * error rather than a choice.
 */
export function hostKeyFingerprint(output: string | undefined): string | null {
  if (output === undefined || output === '') {
    return null
  }
  const found = new Set<string>()
  let block: string[] | null = null
  for (const line of decode(output).split(/\r?\n/)) {
    if (line.includes(BEGIN)) {
      block = []
      continue
    }
    if (block === null) {
      continue
    }
    if (line.includes(END)) {
      block.forEach(fingerprint => found.add(fingerprint))
      block = null
      continue
    }
    const fingerprint = ENTRY.exec(line)?.[1]
    if (fingerprint !== undefined && isFingerprint(fingerprint)) {
      block.push(fingerprint)
    }
  }
  if (found.size > 1) {
    return unverified()
  }
  return [...found][0] ?? null
}
