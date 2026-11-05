import { atLeast } from './baseline'
import { INCUS_SPEC, REQUIRED_PACKAGES, type Architecture } from './spec'
import { fromRepository, installedPins } from './verify'
import type { Observation, PackageChange } from './types'

export type Selection = { pins: PackageChange[] } | { reasons: string[] }

interface Release {
  version: string
  key: string
}

/**
 * Zabbly's full version: epoch, upstream release, Ubuntu series, and a build
 * stamp. Anything else is not a build this recipe knows how to rank.
 */
const VERSION = /^1:(\d+)\.(\d+)(?:\.(\d+))?-ubuntu\d+\.\d+-(\d{12})$/

/**
 * Null means the version is not a Zabbly build or lies outside the supported
 * range. The key sorts by release number and then build stamp as plain text.
 */
function releaseOf(version: string): Release | null {
  const match = VERSION.exec(version)
  const { minimum, maximumExclusive } = INCUS_SPEC.versions
  if (match === null || !atLeast(version, minimum) || atLeast(version, maximumExclusive)) {
    return null
  }
  const [, major = '', minor = '', patch = '0', stamp = ''] = match
  const key = [major, minor, patch].map(part => part.padStart(6, '0')).join('.')
  return { version, key: `${key}-${stamp}` }
}

function newestFirst(left: Release, right: Release): number {
  return left.key < right.key ? 1 : left.key > right.key ? -1 : 0
}

function listed(observation: Observation, name: string): Release[] {
  return observation.repository.candidates.flatMap(candidate => {
    const release = candidate.package === name && fromRepository(candidate.source) ? releaseOf(candidate.version) : null
    return release === null ? [] : [release]
  })
}

/**
 * The one version that the given pins share, or null when the required packages
 * are missing from them or differ.
 */
export function versionOf(pins: readonly PackageChange[]): string | null {
  const [first, ...rest] = pins.filter(pin => REQUIRED_PACKAGES.includes(pin.name))
  return first !== undefined && rest.every(pin => pin.version === first.version) ? first.version : null
}

/**
 * Pure choice of the Incus build to install. When both required packages are
 * already installed their shared version is the selection, and differing
 * versions are refused rather than upgraded or downgraded. Otherwise it is the
 * newest build that the approved repository lists for both packages within the
 * supported range, on the native architecture.
 */
export function selectPins(observation: Observation, architecture: Architecture): Selection {
  const { minimum, maximumExclusive } = INCUS_SPEC.versions
  const installed = installedPins(observation)
  if (installed.length === REQUIRED_PACKAGES.length) {
    const version = versionOf(installed)
    return version !== null && releaseOf(version) !== null && installed.every(pin => pin.architecture === architecture)
      ? { pins: installed }
      : {
          reasons: [
            `The installed Incus packages do not share one supported Zabbly build for ${architecture}. Qiln never upgrades, downgrades, or swaps package architectures.`,
          ],
        }
  }
  const common = REQUIRED_PACKAGES.map(name => listed(observation, name)).reduce((shared, list) =>
    shared.filter(release => list.some(other => other.version === release.version)),
  )
  const [newest] = common.sort(newestFirst)
  if (newest === undefined) {
    return {
      reasons: [
        `APT lists no Incus build from the approved repository for both required packages from ${minimum} up to, not including, ${maximumExclusive}. No other build is substituted.`,
      ],
    }
  }
  return { pins: REQUIRED_PACKAGES.map(name => ({ name, version: newest.version, architecture })) }
}
