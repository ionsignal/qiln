import nodeOs from 'node:os'
import { readFile } from 'node:fs/promises'
import { QilnInstallerError } from '../error'
import { findExecutable, runProcess } from '../process'
import { INSTALLER_SPEC } from '../install/spec'

type Tool = (typeof INSTALLER_SPEC.tools)[number]

export type RequiredTool = Tool['name']

export interface HostPreflight {
  distributionId: string
  distributionVersion: string
  kernelRelease: string
  nodeArchitecture: string
  incusPackageName: string
  incusPackageVersion: string
  commandPaths: Record<RequiredTool, string>
}

interface InstalledPackage {
  name: string
  version: string
}

interface KernelRelease {
  major: number
  minor: number
  patch: number
  abi: number
  flavour: string | null
}

const os = {
  parse(content: string): { id: string; version: string } {
    const values: Partial<Record<'ID' | 'VERSION_ID', string>> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue
      }
      const assignment = /^(ID|VERSION_ID)=(.*)$/.exec(trimmed)
      if (!assignment) {
        if (/^(ID|VERSION_ID)(?:\s|$)/.test(trimmed)) {
          throw new Error('Required OS-release field is malformed.')
        }
        continue
      }
      const key = assignment[1]
      const rawValue = assignment[2]
      if ((key !== 'ID' && key !== 'VERSION_ID') || rawValue === undefined) {
        throw new Error('Required OS-release field is malformed.')
      }
      if (values[key] !== undefined) {
        throw new Error('Required OS-release field is duplicated.')
      }
      const quote = rawValue.charAt(0)
      let value = rawValue
      if (quote === '"' || quote === "'") {
        if (rawValue.length < 2 || rawValue.at(-1) !== quote) {
          throw new Error('Required OS-release field has an unterminated quoted value.')
        }
        value = rawValue.slice(1, -1)
      } else if (rawValue.includes('"') || rawValue.includes("'")) {
        throw new Error('Required OS-release field has an invalid quoted value.')
      }
      if (value === '') {
        throw new Error('Required OS-release field cannot be empty.')
      }
      values[key] = value
    }
    const id = values.ID
    const version = values.VERSION_ID
    if (id === undefined || version === undefined) {
      throw new Error('Required OS-release fields are missing.')
    }
    return {
      id,
      version,
    }
  },
}

const kernel = {
  parse(release: string): KernelRelease | null {
    const match = /^(\d+)\.(\d+)\.(\d+)-(\d+)(?:-([A-Za-z0-9][A-Za-z0-9._+-]*))?$/.exec(release)
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
    return {
      major,
      minor,
      patch,
      abi,
      flavour: match[5] ?? null,
    }
  },

  meets(actual: KernelRelease, minimum: KernelRelease): boolean {
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
  },
}

const minimumKernel = kernel.parse(INSTALLER_SPEC.supportedHost.minimumKernelRelease)
if (!minimumKernel) {
  throw new Error('Installer kernel policy is invalid.')
}

const tools = {
  async require(tool: Tool): Promise<string> {
    const executable = await findExecutable(tool.name)
    if (executable) {
      return executable
    }
    throw new QilnInstallerError({
      code: 'MISSING_HOST_TOOL',
      check: `required host tool '${tool.name}'`,
      summary: `The required host tool '${tool.name}' is not available.`,
      observed: `No executable named '${tool.name}' was found in the invoking developer's PATH.`,
      reason: 'Qiln does not install host packages or invoke privilege escalation.',
      operatorAction: `Review and run 'sudo apt update && sudo apt install ${tool.packageName}' manually, then return to a normal unprivileged developer session.`,
      rerun: 'qiln doctor',
    })
  },

  async all(): Promise<Record<RequiredTool, string>> {
    const paths = {} as Record<RequiredTool, string>
    for (const tool of INSTALLER_SPEC.tools) {
      paths[tool.name] = await tools.require(tool)
    }
    return paths
  },
}

const deb = {
  async package(dpkgQuery: string, name: string): Promise<InstalledPackage | null> {
    const result = await runProcess(dpkgQuery, ['-W', '-f=${binary:Package}\t${db:Status-Abbrev}\t${Version}\n', name])
    if (result.exitCode === 1) {
      return null
    }
    if (result.exitCode !== 0) {
      throw new QilnInstallerError({
        code: 'PACKAGE_QUERY_FAILED',
        check: `installed package '${name}'`,
        summary: `The installed package '${name}' could not be inspected safely.`,
        observed: `dpkg-query returned exit code ${result.exitCode ?? 'unknown'} while inspecting '${name}'.`,
        reason: 'Qiln cannot determine whether the required local package is installed and compatible.',
        operatorAction:
          'Inspect and repair the local dpkg package database manually. Qiln will not modify package-management state.',
        rerun: 'qiln doctor',
      })
    }
    const [packageName, status, version] = result.stdout.trim().split('\t')
    if (!packageName || status !== 'ii ' || !version) {
      return null
    }
    return {
      name: packageName,
      version,
    }
  },

  async compare(dpkg: string, version: string, operator: 'ge' | 'lt', expectedVersion: string): Promise<boolean> {
    const result = await runProcess(dpkg, ['--compare-versions', version, operator, expectedVersion])
    if (result.exitCode === 0) {
      return true
    }
    if (result.exitCode === 1) {
      return false
    }
    throw new QilnInstallerError({
      code: 'PACKAGE_VERSION_CHECK_FAILED',
      check: 'Incus package version',
      summary: 'The installed Incus package version could not be compared safely.',
      observed: `dpkg returned exit code ${result.exitCode ?? 'unknown'} while comparing the installed package.`,
      reason: 'Qiln cannot determine whether the installed Incus release is within the supported major-version range.',
      operatorAction: 'Inspect the local dpkg installation and repair package-management metadata manually.',
      rerun: 'qiln doctor',
    })
  },

  bound(version: string): { minimum: string; maximumExclusive: string } {
    const epoch = /^(\d+):/.exec(version)?.[1]
    const prefix = epoch === undefined ? '' : `${epoch}:`
    return {
      minimum: `${prefix}${INSTALLER_SPEC.supportedHost.minimumIncusVersion}`,
      maximumExclusive: `${prefix}${INSTALLER_SPEC.supportedHost.maximumIncusVersionExclusive}`,
    }
  },

  async incus(dpkg: string, dpkgQuery: string): Promise<InstalledPackage> {
    const candidates = (
      await Promise.all([deb.package(dpkgQuery, 'incus'), deb.package(dpkgQuery, 'incus-base')])
    ).filter((candidate): candidate is InstalledPackage => candidate !== null)
    if (candidates.length === 0) {
      throw new QilnInstallerError({
        code: 'INCUS_PACKAGE_MISSING',
        check: 'Incus package installation',
        summary: 'No supported Incus server package is installed.',
        observed: "Neither the 'incus' nor 'incus-base' package is installed according to dpkg.",
        reason: 'Qiln does not install or upgrade Incus and cannot bootstrap the host daemon.',
        operatorAction:
          'Install Incus manually using the reviewed Ubuntu or Zabbly installation procedure at https://github.com/zabbly/incus, enable the service, and return to a new developer login session if group membership changes.',
        rerun: 'qiln doctor',
      })
    }
    for (const candidate of candidates) {
      const bounds = deb.bound(candidate.version)
      const meetsMinimum = await deb.compare(dpkg, candidate.version, 'ge', bounds.minimum)
      const belowMaximum = await deb.compare(dpkg, candidate.version, 'lt', bounds.maximumExclusive)
      if (meetsMinimum && belowMaximum) {
        return candidate
      }
    }
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_INCUS_PACKAGE_VERSION',
      check: 'Incus package version',
      summary: 'The installed Incus package is outside the supported version range.',
      observed: `Installed package versions: ${candidates.map(candidate => `${candidate.name}=${candidate.version}`).join(', ')}.`,
      reason: `Batch 1 requires Incus >= ${INSTALLER_SPEC.supportedHost.minimumIncusVersion} and < ${INSTALLER_SPEC.supportedHost.maximumIncusVersionExclusive} within the package version epoch. Package version alone does not establish Ubuntu or Zabbly publisher provenance.`,
      operatorAction:
        'Review the approved Incus installation source and manually install a supported Incus 7.x package. Qiln will not perform the upgrade.',
      rerun: 'qiln doctor',
    })
  },
}

export async function validateHostPreflight(): Promise<HostPreflight> {
  if (process.platform !== 'linux') {
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_HOST_PLATFORM',
      check: 'host operating system',
      summary: 'Qiln requires a Linux host.',
      observed: `Node reports platform '${process.platform}'.`,
      reason: 'The local Incus daemon, ZFS checks, and Unix-socket installer boundary are Linux-specific.',
      operatorAction: 'Run the installer on the supported Ubuntu 24.04 host.',
      rerun: 'qiln doctor',
    })
  }
  let release: { id: string; version: string }
  try {
    release = os.parse(await readFile('/etc/os-release', 'utf8'))
  } catch (error: unknown) {
    throw new QilnInstallerError({
      code: 'HOST_RELEASE_UNAVAILABLE',
      check: 'host operating-system release',
      summary: 'The Ubuntu host release could not be identified.',
      observed: '/etc/os-release could not be read or contains malformed required ID or VERSION_ID fields.',
      reason: 'Qiln must prove that it is running on the supported Ubuntu release before dependent checks.',
      operatorAction: 'Run Qiln on a normal Ubuntu 24.04 installation with readable operating-system release metadata.',
      rerun: 'qiln doctor',
      cause: error,
    })
  }
  const distributionId = release.id.toLowerCase()
  const distributionVersion = release.version
  if (
    distributionId !== INSTALLER_SPEC.supportedHost.distributionId ||
    distributionVersion !== INSTALLER_SPEC.supportedHost.versionId
  ) {
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_UBUNTU_RELEASE',
      check: 'host operating-system release',
      summary: 'The host is not the supported Ubuntu 24.04 release.',
      observed: `Detected ID='${distributionId || 'unknown'}' and VERSION_ID='${distributionVersion || 'unknown'}'.`,
      reason: 'The MVP installer policy is intentionally limited to Ubuntu 24.04.',
      operatorAction: 'Provision the documented Ubuntu 24.04 developer host before running Qiln.',
      rerun: 'qiln doctor',
    })
  }
  const nodeArchitecture = process.arch
  if (nodeArchitecture !== INSTALLER_SPEC.supportedHost.nodeArchitecture) {
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_HOST_ARCHITECTURE',
      check: 'host architecture',
      summary: 'The host architecture is not supported by the initial Qiln installer.',
      observed: `Node reports architecture '${nodeArchitecture}'.`,
      reason:
        'The initial MVP supports native AMD64 containers only and does not rely on foreign-architecture emulation.',
      operatorAction: 'Run Qiln on an x86_64/AMD64 Ubuntu 24.04 host.',
      rerun: 'qiln doctor',
    })
  }
  const kernelRelease = nodeOs.release()
  const kernelVersion = kernel.parse(kernelRelease)
  if (!kernelVersion || !minimumKernel || !kernel.meets(kernelVersion, minimumKernel)) {
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_KERNEL_VERSION',
      check: 'running Linux kernel',
      summary: 'The running Linux kernel does not meet the Qiln policy.',
      observed: `Detected kernel '${kernelRelease}'; required kernel is >= ${INSTALLER_SPEC.supportedHost.minimumKernelRelease}.`,
      reason: 'The selected Incus release and Qiln installation policy require the documented modern kernel baseline.',
      operatorAction:
        'Install and boot an approved Ubuntu kernel that meets the requirement. Qiln will not install or activate a kernel.',
      rerun: 'qiln doctor',
    })
  }
  const commandPaths = await tools.all()
  const incusPackage = await deb.incus(commandPaths.dpkg, commandPaths['dpkg-query'])
  return {
    distributionId,
    distributionVersion,
    kernelRelease,
    nodeArchitecture,
    incusPackageName: incusPackage.name,
    incusPackageVersion: incusPackage.version,
    commandPaths,
  }
}
