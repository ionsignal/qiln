import { INCUS_SPEC } from './spec'
import { allocationsOf } from './idmap'
import { baselineSchema, type Baseline, type Observation, type PackageChange } from './types'

export { baselineSchema }
export type { Baseline }

type Software = Pick<Baseline, 'architecture' | 'packages'>

/**
 * Whether a replacement host can reuse the recorded software. `missing` means
 * that nothing differs but a recorded pinned package is absent, which a restore
 * from the retained package files answers. `differs` is never reconciled: no
 * upgrade, downgrade, or architecture swap is offered.
 */
export type Comparison = { kind: 'match' } | { kind: 'missing' } | { kind: 'differs'; reasons: string[] }

const PINNED_PATTERNS = INCUS_SPEC.software.pinned.map(glob => new RegExp(`^${glob.replace('*', '.*')}$`))

export function isPinned(name: string): boolean {
  return PINNED_PATTERNS.some(pattern => pattern.test(name))
}

function byName(left: PackageChange, right: PackageChange): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * Null means there is nothing to record: the installation is incomplete or a
 * subordinate-ID file was unreadable. A preserved open passes its retained
 * baseline so its ranges stay unchanged and extra ranges never ratchet into the
 * record.
 */
export function baselineOf(observation: Observation, retained: Baseline | null = null): Baseline | null {
  const parsed = baselineSchema.safeParse({
    architecture: observation.system.packageArchitecture,
    packages: [...observation.software].sort(byName),
    allocations: retained?.allocations ?? allocationsOf(observation),
  })
  return parsed.success ? parsed.data : null
}

export function compareSoftware(recorded: Software, observation: Observation): Comparison {
  const { packageArchitecture } = observation.system
  if (recorded.architecture !== packageArchitecture) {
    return {
      kind: 'differs',
      reasons: [`The host package architecture is ${packageArchitecture}, but ${recorded.architecture} was recorded.`],
    }
  }
  let missing = false
  const reasons: string[] = []
  for (const wanted of recorded.packages.filter(item => isPinned(item.name))) {
    const found = observation.software.find(item => item.name === wanted.name)
    if (found === undefined) {
      missing = true
    } else if (found.version !== wanted.version || found.architecture !== wanted.architecture) {
      reasons.push(`${wanted.name} ${found.version} is installed, but ${wanted.version} was recorded.`)
    }
  }
  if (reasons.length > 0) {
    return { kind: 'differs', reasons }
  }
  return missing ? { kind: 'missing' } : { kind: 'match' }
}

/**
 * The leading dotted number of a Debian or kernel version, without an epoch.
 */
function numbersOf(version: string): number[] | null {
  const match = /^(?:\d+:)?(\d+(?:\.\d+)*)/.exec(version)
  return match === null ? null : match[1].split('.').map(Number)
}

/**
 * Compares only the leading dotted number, so `1:6.0.4-0ubuntu1` and
 * `7.0.0-14-generic` are judged by `6.0.4` and `7.0.0`. An unreadable version
 * never meets a floor.
 */
export function atLeast(version: string, minimum: string): boolean {
  const actual = numbersOf(version)
  const floor = numbersOf(minimum)
  if (actual === null || floor === null) {
    return false
  }
  for (let index = 0; index < Math.max(actual.length, floor.length); index++) {
    const have = actual[index] ?? 0
    const need = floor[index] ?? 0
    if (have !== need) {
      return have > need
    }
  }
  return true
}
