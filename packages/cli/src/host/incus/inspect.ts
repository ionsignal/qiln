import { z } from 'zod'
import { SCRIPTS } from './recipe'
import { ARCHITECTURES, INCUS_SPEC, packagePins } from './spec'
import { PACKAGE_SPEC, transactionOf } from '../apt'
import { isPinned } from './baseline'
import { shellCommand } from '../shell'
import { datasetsOf } from '../zfs/dataset'
import { InstallerError } from '../../diagnostic/error'
import { mountOf, STATE_MOUNTPOINT } from '../mount'
import { outputOf, tagged, type Section } from '../output'
import { observationSchema, type IdRange, type InspectTarget, type Observation } from './types'
import type { Remote } from '../../transport/ssh/connections'

/**
 * Carries only authored wording. Raw output, host names, and tool messages
 * never enter the diagnostic.
 */
function inspectionFailure(reason: string): InstallerError {
  return new InstallerError({
    code: 'AWS_INCUS_INSPECTION_FAILED',
    facts: [['Reason', reason]],
  })
}

const { fields, required, sections, succeeded, yesNo } = outputOf(inspectionFailure)

/**
 * Provider JSON is validated loosely and then reduced to the strict observation.
 * A nil Go map or slice marshals as null, so both read as empty.
 */
const settings = z
  .record(z.string(), z.string())
  .nullable()
  .transform(value => value ?? {})

function list<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .nullable()
    .transform(value => value ?? [])
}

const envelopeSchema = z.looseObject({ type: z.literal('sync'), metadata: z.unknown() })

/**
 * `driver` and `driver_version` are pipe-separated lists that correspond by
 * position, such as `lxc | qemu` and `7.0.0 | 11.1.2`.
 */
const serverSchema = z.looseObject({
  config: settings,
  api_extensions: z.array(z.string()),
  environment: z.looseObject({
    server_version: z.string(),
    certificate_fingerprint: z.string(),
    server_clustered: z.boolean(),
    driver: z.string().default(''),
    driver_version: z.string().default(''),
  }),
})
const projectSchema = z.looseObject({ name: z.string() })
const poolSchema = z.looseObject({ name: z.string(), driver: z.string(), config: settings })
const networkSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  managed: z.boolean(),
  config: settings,
})
const profileSchema = z.looseObject({
  name: z.string(),
  config: settings,
  devices: z
    .record(z.string(), z.record(z.string(), z.string()))
    .nullable()
    .transform(value => value ?? {}),
})
const instanceSchema = z.looseObject({
  project: z.string(),
  name: z.string(),
  status: z.string(),
  ephemeral: z.boolean(),
  config: settings,
})
const imageSchema = z.looseObject({ fingerprint: z.string() })

/**
 * `query --raw` keeps the API envelope, so the payload is its `metadata`.
 */
function metadata<T>(section: Section, subject: string, schema: z.ZodType<T>): T {
  let json: unknown
  try {
    json = JSON.parse(section.lines.join('\n'))
  } catch {
    throw inspectionFailure(`The ${subject} response was not valid JSON.`)
  }
  const envelope = envelopeSchema.safeParse(json)
  const parsed = envelope.success ? schema.safeParse(envelope.data.metadata) : undefined
  if (parsed === undefined || !parsed.success) {
    throw inspectionFailure(`The ${subject} response was not in the expected form.`)
  }
  return parsed.data
}

function systemOf(section: Section) {
  const values = fields(section.lines)
  return {
    packageArchitecture: values.get('packageArchitecture'),
    machine: values.get('machine'),
    kernel: values.get('kernel'),
    ipForward: yesNo(values.get('ipForward'), 'IP forwarding'),
  }
}

/**
 * A version the host could not report is null, never a default, so a missing
 * probe can never meet a floor.
 */
function runtimeOf(section: Section) {
  const values = fields(section.lines)
  return {
    zfs: values.get('zfs') || null,
    zfsModule: values.get('zfsModule') || null,
  }
}

/**
 * One reported file, as `file <sha256>`, `absent`, or `other`.
 */
function fileState(value: string) {
  const [kind, sha256] = value.split(' ')
  return { kind, sha256: sha256 ?? null }
}

function repositoryOf(files: Section, madison: Section) {
  const found: Record<string, ReturnType<typeof fileState>> = {}
  const conflicts: string[] = []
  for (const [tag, value] of tagged(files.lines)) {
    if (tag === 'conflict') {
      conflicts.push(value)
    } else if (tag === 'key' || tag === 'source' || tag === 'preferences') {
      found[tag] = fileState(value)
    } else {
      throw inspectionFailure('The repository inspection reported an unrecognized line.')
    }
  }
  const candidates = madison.lines
    .filter(line => line.trim() !== '')
    .map(line => {
      const [name, version, source] = line.split('|').map(part => part.trim())
      return { package: name, version, source }
    })
  return { key: found.key, source: found.source, preferences: found.preferences, conflicts, candidates }
}

/**
 * The override file must be reported, so a missing line is malformed output and
 * never reads as an absent file. The running value is null when it could not be
 * read, never a default.
 */
function sysctlOf(section: Section) {
  const values = fields(section.lines)
  const override = values.get('override')
  if (override === undefined) {
    throw inspectionFailure('The sysctl inspection did not report the override file.')
  }
  return { override: fileState(override), apparmor: values.get('apparmor') || null }
}

/**
 * Every guard file must be reported, so a missing line is malformed output and
 * never reads as an absent file.
 */
function guardOf(section: Section) {
  const values = fields(section.lines)
  const read = (name: string) => {
    const value = values.get(name)
    if (value === undefined) {
      throw inspectionFailure('The guard inspection did not report every file.')
    }
    return fileState(value)
  }
  return { expectation: read('expectation'), check: read('check'), dropIn: read('dropIn') }
}

function installedOf(section: Section) {
  return section.lines
    .filter(line => line !== '')
    .flatMap(line => {
      const [name, version, architecture, state] = line.split('\t')
      return state === 'installed' ? [{ name, version, architecture }] : []
    })
}

/**
 * Each line is `service <unit> <load> <unit-file> <activation>`, taken from
 * machine-readable unit properties. A missing field fails validation, so
 * incomplete evidence never reads as inactive.
 */
function servicesOf(section: Section) {
  return tagged(section.lines).map(([tag, value]) => {
    if (tag !== 'service') {
      throw inspectionFailure('The service inspection reported an unrecognized line.')
    }
    const [unit, load, enablement, activation] = value.split(' ')
    return { unit, load, enablement, activation }
  })
}

function listenersOf(section: Section): string[] {
  return tagged(section.lines).map(([tag, value]) => {
    if (tag !== 'listener') {
      throw inspectionFailure('The listener inspection reported an unrecognized line.')
    }
    return value
  })
}

function networkOf(section: Section) {
  const routes: string[] = []
  const links: string[] = []
  for (const [tag, value] of tagged(section.lines)) {
    if (tag === 'route') {
      routes.push(value)
    } else if (tag === 'link') {
      links.push(value)
    } else {
      throw inspectionFailure('The network inspection reported an unrecognized line.')
    }
  }
  return { routes, links }
}

/**
 * The account is the one the inspection was asked about, so it comes from the
 * caller and not from the host's output.
 */
function accessOf(section: Section, account: string) {
  const values = fields(section.lines)
  return {
    account,
    groupExists: yesNo(values.get('group'), 'access group'),
    member: yesNo(values.get('member'), 'group membership'),
  }
}

/**
 * A file that could not be read is null, which is not the same as an empty list,
 * a readable file without a root range.
 */
function idmapOf(section: Section) {
  const readable = { uid: false, gid: false }
  const ranges: { uid: IdRange[]; gid: IdRange[] } = { uid: [], gid: [] }
  for (const [tag, value] of tagged(section.lines)) {
    const [start, count] = value.split(' ')
    switch (tag) {
      case 'uidFile':
        readable.uid = yesNo(value, 'subordinate UID file')
        break
      case 'gidFile':
        readable.gid = yesNo(value, 'subordinate GID file')
        break
      case 'uid':
        ranges.uid.push({ start: Number(start), count: Number(count) })
        break
      case 'gid':
        ranges.gid.push({ start: Number(start), count: Number(count) })
        break
      default:
        throw inspectionFailure('The allocation inspection reported an unrecognized line.')
    }
  }
  return { uid: readable.uid ? ranges.uid : null, gid: readable.gid ? ranges.gid : null }
}

/**
 * Whether the state directory holds nothing, and whether every retained
 * metadata entry is present. Both are required fields, never defaults.
 */
function stateOf(section: Section) {
  const values = fields(section.lines)
  return {
    empty: yesNo(values.get('empty'), 'state directory emptiness'),
    metadata: yesNo(values.get('metadata'), 'retained metadata'),
  }
}

function zfsOf(section: Section) {
  let available = false
  let pool: { name: string; guid: string } | null = null
  const datasets: { name: string; mounted: boolean }[] = []
  const entries: string[] = []
  for (const [tag, value] of tagged(section.lines)) {
    const [first, second] = value.split(' ')
    switch (tag) {
      case 'available':
        available = yesNo(value, 'ZFS availability')
        break
      case 'pool':
        pool = { name: first, guid: second }
        break
      case 'dataset':
        datasets.push({ name: first, mounted: yesNo(second, 'dataset mount') })
        break
      case 'properties':
        entries.push(value)
        break
      default:
        throw inspectionFailure('The ZFS inspection reported an unrecognized line.')
    }
  }
  return { available, pool, datasets, topLevel: datasetsOf(entries, inspectionFailure) }
}

/**
 * The LXC version that the daemon reports, taken from the entry of the `lxc`
 * driver. Null means the daemon reported none, never a default.
 */
function lxcVersionOf(driver: string, driverVersion: string): string | null {
  const names = driver.split('|').map(part => part.trim())
  const versions = driverVersion.split('|').map(part => part.trim())
  return versions[names.indexOf('lxc')] || null
}

/**
 * The API sections exist only when the script judged the daemon service
 * running. Their absence is a value (`null`), never an empty result.
 */
function apiOf(found: ReadonlyMap<string, Section>) {
  const reachable = yesNo(fields(succeeded(found, 'api').lines).get('reachable'), 'API reachability')
  if (!reachable) {
    return null
  }
  const read = <T>(name: string, schema: z.ZodType<T>) => metadata(succeeded(found, name), name, schema)
  const server = read('server', serverSchema)
  return {
    server: {
      config: server.config,
      extensions: server.api_extensions,
      version: server.environment.server_version,
      certificateFingerprint: server.environment.certificate_fingerprint,
      clustered: server.environment.server_clustered,
      lxc: lxcVersionOf(server.environment.driver, server.environment.driver_version),
    },
    projects: read('projects', list(projectSchema)).map(project => project.name),
    pools: read('storage', list(poolSchema)).map(({ name, driver, config }) => ({ name, driver, config })),
    networks: read('networks', list(networkSchema)).map(({ name, type, managed, config }) => ({
      name,
      type,
      managed,
      config,
    })),
    profiles: read('profiles', list(profileSchema)).map(({ name, config, devices }) => ({ name, config, devices })),
    instances: read('instances', list(instanceSchema)).map(({ project, name, status, ephemeral, config }) => ({
      project,
      name,
      status,
      ephemeral,
      autostart: config['boot.autostart'] ?? null,
    })),
    images: read('images', list(imageSchema)).length,
  }
}

/**
 * Runs the fixed inspection and validates its output into one observation.
 * Transport failures propagate unchanged: a failed channel ends the connection,
 * so nothing further runs on it. `target.pool` selects the one ZFS pool whose
 * datasets are reported, and null reports none, which is how the software stage
 * runs before any pool is imported. `target.account` is the account whose Incus
 * group membership is reported. A fresh installation simulates the exact native
 * package pins. `target.retained` instead supplies the recorded pinned packages,
 * which the planner must also find compatible with the selected recipe.
 * `approved` names the packages of an approved transaction, so a verification
 * checks all of them and not only the direct ones; they are reported but never
 * simulated. Every section except the API is offline evidence. The API is read
 * only while the daemon service is already running, so inspection never starts
 * the daemon through socket activation.
 */
export async function inspectHost(
  remote: Remote,
  target: InspectTarget,
  approved: readonly string[] = [],
): Promise<Observation> {
  const { repository, network, access, guard, sysctl, packages, companions, excluded, software, retained, inspect } =
    INCUS_SPEC
  const architectureResult = await remote.exec('dpkg --print-architecture', inspect)
  const architecture = ARCHITECTURES.find(name => name === architectureResult.stdout.trim())
  if (architectureResult.exitCode !== 0 || architecture === undefined) {
    throw inspectionFailure('The native package architecture is neither amd64 nor arm64 or could not be read.')
  }
  const known = new Set<string>([...packages, ...companions, ...excluded])
  const reported = [...companions, ...excluded, ...approved.filter(name => !known.has(name))]
  const selected = target.retained === undefined || target.retained === null
    ? packagePins(architecture)
    : target.retained.baseline.packages.filter(change => isPinned(change.name))
  const specifications = selected.map(change => `${change.name}=${change.version}`)
  if (!specifications.every(item => PACKAGE_SPEC.test(item))) {
    throw inspectionFailure('A selected package version is not a plain name and version.')
  }
  const command = shellCommand(
    SCRIPTS.inspect,
    [
      target.pool ?? '',
      repository.keyFile,
      repository.sourceFile,
      network.subnet,
      target.account,
      access.group,
      STATE_MOUNTPOINT,
      guard.expectationFile,
      guard.checkFile,
      guard.dropInFile,
      repository.preferencesFile,
      sysctl.file,
      sysctl.key,
      ...packages,
      '--',
      ...reported,
      '--',
      ...specifications,
      '--',
      ...retained.metadata,
      '--',
      ...software.patterns,
    ],
    { privileged: true },
  )
  const result = await remote.exec(command, inspect)
  if (result.exitCode !== 0) {
    throw inspectionFailure(`The inspection script exited with code ${result.exitCode}.`)
  }
  const found = sections(result.stdout)
  const simulation = required(found, 'simulation')
  const draft = {
    observedAt: new Date().toISOString(),
    system: systemOf(succeeded(found, 'system')),
    runtime: runtimeOf(succeeded(found, 'runtime')),
    repository: repositoryOf(succeeded(found, 'repository'), succeeded(found, 'candidates')),
    sysctl: sysctlOf(succeeded(found, 'sysctl')),
    guard: guardOf(succeeded(found, 'guard')),
    packages: installedOf(succeeded(found, 'packages')),
    software: installedOf(succeeded(found, 'software')),
    transaction: transactionOf(simulation, inspectionFailure),
    services: servicesOf(succeeded(found, 'services')),
    listeners: listenersOf(succeeded(found, 'listeners')),
    network: networkOf(succeeded(found, 'network')),
    access: accessOf(succeeded(found, 'access'), target.account),
    idmap: idmapOf(succeeded(found, 'idmap')),
    zfs: zfsOf(succeeded(found, 'zfs')),
    stateMount: mountOf(succeeded(found, 'mount'), inspectionFailure),
    state: stateOf(succeeded(found, 'state')),
    api: apiOf(found),
  }
  const parsed = observationSchema.safeParse(draft)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join('.') ?? 'observation'
    throw inspectionFailure(`The field ${field} was missing or out of range.`)
  }
  if (parsed.data.system.packageArchitecture !== architecture) {
    throw inspectionFailure('The native package architecture changed during inspection.')
  }
  return parsed.data
}
