import nodeOs from 'node:os'
import { readFile } from 'node:fs/promises'
import { InstallerError } from '../diagnostic/error'
import { findExecutable, runProcess } from '../process'
import { INSTALLER_SPEC } from '../install/spec'
import { architectureOf, type Architecture } from '../install/architecture'
import { requireSupportedRelease } from '../install/host'

type Tool = (typeof INSTALLER_SPEC.tools)[number]

export type RequiredTool = Tool['name']

export interface HostPreflight {
  distributionId: string
  distributionVersion: string
  kernelRelease: string
  architecture: Architecture
  incusPackageName: string
  incusPackageVersion: string
  commandPaths: Record<RequiredTool, string>
}

interface InstalledPackage {
  name: string
  version: string
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

const tools = {
  async require(tool: Tool, retry: string): Promise<string> {
    const executable = await findExecutable(tool.name)
    if (executable) {
      return executable
    }
    throw new InstallerError({
      code: 'MISSING_HOST_TOOL',
      facts: [
        ['Tool', tool.name],
        ['Package', tool.packageName],
      ],
      retry,
    })
  },

  async all(retry: string): Promise<Record<RequiredTool, string>> {
    const paths = {} as Record<RequiredTool, string>
    for (const tool of INSTALLER_SPEC.tools) {
      paths[tool.name] = await tools.require(tool, retry)
    }
    return paths
  },
}

/**
 * Locates one declared tool on the operator's machine, so a target that needs
 * only some of the tools does not require the rest.
 */
export async function requireTool(name: RequiredTool, retry: string): Promise<string> {
  const tool = INSTALLER_SPEC.tools.find(item => item.name === name)
  if (tool === undefined) {
    throw new RangeError(`'${name}' is not a declared required tool.`)
  }
  return await tools.require(tool, retry)
}

const deb = {
  async package(dpkgQuery: string, name: string, retry: string): Promise<InstalledPackage | null> {
    const result = await runProcess(dpkgQuery, ['-W', '-f=${binary:Package}\t${db:Status-Abbrev}\t${Version}\n', name])
    if (result.exitCode === 1) {
      return null
    }
    if (result.exitCode !== 0) {
      throw new InstallerError({
        code: 'PACKAGE_QUERY_FAILED',
        facts: [
          ['Observed', `dpkg-query returned exit code ${result.exitCode ?? 'unknown'} while inspecting '${name}'.`],
        ],
        retry,
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

  async compare(
    dpkg: string,
    version: string,
    operator: 'ge' | 'lt',
    expectedVersion: string,
    retry: string,
  ): Promise<boolean> {
    const result = await runProcess(dpkg, ['--compare-versions', version, operator, expectedVersion])
    if (result.exitCode === 0) {
      return true
    }
    if (result.exitCode === 1) {
      return false
    }
    throw new InstallerError({
      code: 'PACKAGE_VERSION_CHECK_FAILED',
      facts: [
        ['Observed', `dpkg returned exit code ${result.exitCode ?? 'unknown'} while comparing the installed package.`],
      ],
      retry,
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

  async incus(dpkg: string, dpkgQuery: string, retry: string): Promise<InstalledPackage> {
    const candidates = (
      await Promise.all([deb.package(dpkgQuery, 'incus', retry), deb.package(dpkgQuery, 'incus-base', retry)])
    ).filter((candidate): candidate is InstalledPackage => candidate !== null)
    if (candidates.length === 0) {
      throw new InstallerError({
        code: 'INCUS_PACKAGE_MISSING',
        facts: [['Observed', "Neither the 'incus' nor 'incus-base' package is installed according to dpkg."]],
        retry,
      })
    }
    for (const candidate of candidates) {
      const bounds = deb.bound(candidate.version)
      const meetsMinimum = await deb.compare(dpkg, candidate.version, 'ge', bounds.minimum, retry)
      const belowMaximum = await deb.compare(dpkg, candidate.version, 'lt', bounds.maximumExclusive, retry)
      if (meetsMinimum && belowMaximum) {
        return candidate
      }
    }
    throw new InstallerError({
      code: 'UNSUPPORTED_INCUS_PACKAGE_VERSION',
      facts: [
        [
          'Observed',
          `Installed package versions: ${candidates.map(candidate => `${candidate.name}=${candidate.version}`).join(', ')}.`,
        ],
      ],
      retry,
    })
  },
}

export async function validateHostPreflight(retry: string): Promise<HostPreflight> {
  if (process.platform !== 'linux') {
    throw new InstallerError({
      code: 'UNSUPPORTED_HOST_PLATFORM',
      facts: [['Observed', `Node reports platform '${process.platform}'.`]],
      retry,
    })
  }
  let release: { id: string; version: string }
  try {
    release = os.parse(await readFile('/etc/os-release', 'utf8'))
  } catch (error: unknown) {
    throw new InstallerError({
      code: 'HOST_RELEASE_UNAVAILABLE',
      facts: [
        ['Observed', '/etc/os-release could not be read or contains malformed required ID or VERSION_ID fields.'],
      ],
      retry,
    })
  }
  const distributionId = release.id.toLowerCase()
  const distributionVersion = release.version
  const kernelRelease = nodeOs.release()
  requireSupportedRelease({ distributionId, distributionVersion, kernelRelease }, retry)
  const commandPaths = await tools.all(retry)
  const packageArchitecture = await runProcess(commandPaths.dpkg, ['--print-architecture'])
  const architecture = architectureOf(
    {
      packageArchitecture: packageArchitecture.stdout.trim(),
      machine: nodeOs.machine(),
      node: process.arch,
    },
    retry,
  )
  const incusPackage = await deb.incus(commandPaths.dpkg, commandPaths['dpkg-query'], retry)
  return {
    distributionId,
    distributionVersion,
    kernelRelease,
    architecture,
    incusPackageName: incusPackage.name,
    incusPackageVersion: incusPackage.version,
    commandPaths,
  }
}
