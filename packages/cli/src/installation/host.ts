import { InstallerError } from '../diagnostic/error'
import { INSTALLER_SPEC } from './spec'
import type { Layout } from './layout'

const GIB = 1_073_741_824

export interface HostRelease {
  distributionId: string
  distributionVersion: string
  kernelRelease: string
}

/**
 * The managed checkout as observed on the target. Working-tree state is not
 * inspected, because a Git status can run repository-configured hooks, and a
 * modified working tree is accepted anyway. `commit` is the HEAD that the
 * checkout currently has, and `origin` is its configured origin URL.
 */
export interface CheckoutObservation {
  path: string
  gitRoot: string | null
  commit: string | null
  origin: string | null
  packageName: string | null
}

export interface HostObservation extends HostRelease {
  packageArchitecture: string
  machine: string
  memoryBytes: number
  git: boolean
  checkout: CheckoutObservation | null
}

interface KernelRelease {
  major: number
  minor: number
  patch: number
  abi: number
}

function parseKernel(release: string): KernelRelease | null {
  const match = /^(\d+)\.(\d+)\.(\d+)-(\d+)(?:-[A-Za-z0-9][A-Za-z0-9._+-]*)?$/.exec(release)
  if (!match) {
    return null
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const abi = Number(match[4])
  if (![major, minor, patch, abi].every(Number.isSafeInteger)) {
    return null
  }
  return { major, minor, patch, abi }
}

function meets(actual: KernelRelease, minimum: KernelRelease): boolean {
  for (const [actualPart, minimumPart] of [
    [actual.major, minimum.major],
    [actual.minor, minimum.minor],
    [actual.patch, minimum.patch],
    [actual.abi, minimum.abi],
  ]) {
    if (actualPart > minimumPart) {
      return true
    }
    if (actualPart < minimumPart) {
      return false
    }
  }
  return true
}

/**
 * The release and kernel expectations are shared by local and remote hosts.
 * Observation stays with the caller.
 */
export function requireSupportedRelease(host: HostRelease, retry: string): void {
  const minimumKernel = parseKernel(INSTALLER_SPEC.supportedHost.minimumKernelRelease)
  if (!minimumKernel) {
    throw new Error('Installer kernel policy is invalid.')
  }
  const { distributionId, versionId } = INSTALLER_SPEC.supportedHost
  if (host.distributionId.toLowerCase() !== distributionId || host.distributionVersion !== versionId) {
    throw new InstallerError({
      code: 'UNSUPPORTED_UBUNTU_RELEASE',
      facts: [
        ['Detected release', `${host.distributionId.toLowerCase()} ${host.distributionVersion}`],
        ['Required release', `Ubuntu ${versionId}`],
      ],
      retry,
    })
  }
  const actual = parseKernel(host.kernelRelease)
  if (!actual || !meets(actual, minimumKernel)) {
    throw new InstallerError({
      code: 'UNSUPPORTED_KERNEL_VERSION',
      facts: [
        ['Running kernel', host.kernelRelease],
        ['Minimum kernel', INSTALLER_SPEC.supportedHost.minimumKernelRelease],
      ],
      retry,
    })
  }
}

/**
 * The orchestrator memory limit must fit the total memory the target reports.
 * Only a limit written in whole GiB is judged, and an omitted limit is not
 * applied. This compares configuration with total memory, not free capacity.
 */
export function requireCapacity(layout: Layout, memoryBytes: number, retry: string): void {
  const match = /^([1-9][0-9]*)GiB$/.exec(layout.orchestrator.limits['limits.memory'] ?? '')
  if (match === null || Number(match[1]) * GIB <= memoryBytes) {
    return
  }
  throw new InstallerError({
    code: 'INSTALLATION_TARGET_CAPACITY',
    facts: [
      ['Memory limit', `${match[1]} GiB`],
      ['Observed memory', `${(memoryBytes / GIB).toFixed(1)} GiB total`],
    ],
    retry,
  })
}

/**
 * The managed checkout is cloned and read on the target with git, and Qiln
 * installs no packages, so a target without it is refused before any state is
 * written.
 */
export function requireGit(git: boolean, retry: string): void {
  if (git) {
    return
  }
  throw new InstallerError({
    code: 'SOURCE_GIT_MISSING',
    facts: [
      ['Tool', 'git'],
      ['Package', 'git'],
    ],
    retry,
  })
}
