import { InstallerError, type InstallerErrorCode } from '../diagnostic/error'
import { INSTALLER_SPEC } from './spec'
import type { Layout } from './layout'

const GIB = 1_073_741_824

export interface HostRelease {
  distributionId: string
  distributionVersion: string
  kernelRelease: string
}

/**
 * The checkout as observed on the target. A modified working tree is accepted:
 * `commit` only identifies the committed baseline it started from.
 */
export interface CheckoutObservation {
  path: string
  gitRoot: string | null
  commit: string | null
  branch: string | null
  modified: boolean
  packageName: string | null
}

export interface HostObservation extends HostRelease {
  packageArchitecture: string
  machine: string
  memoryBytes: number
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
 * The checkout must be the Git root of the Qiln package with a committed
 * baseline. Nothing else about its contents is judged.
 */
export function requireCheckout(checkout: CheckoutObservation | null, retry: string): CheckoutObservation {
  const refuse = (code: InstallerErrorCode, observed: string) =>
    new InstallerError({
      code,
      facts: [['Observed', observed]],
      retry,
    })
  if (checkout === null) {
    throw refuse('INVALID_SOURCE_CHECKOUT', 'The checkout directory does not exist on the target.')
  }
  if (checkout.gitRoot === null || checkout.commit === null) {
    throw refuse('SOURCE_NOT_GIT_CHECKOUT', `${checkout.path} is not a Git work tree with a committed baseline.`)
  }
  if (checkout.gitRoot !== checkout.path) {
    throw new InstallerError({
      code: 'SOURCE_NOT_CHECKOUT_ROOT',
      facts: [
        ['Selected source', checkout.path],
        ['Checkout root', checkout.gitRoot],
      ],
      retry,
    })
  }
  if (checkout.packageName !== 'qiln') {
    throw refuse('SOURCE_NOT_QILN_PACKAGE', "package.json must have name='qiln'.")
  }
  return checkout
}
