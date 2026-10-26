import { z } from 'zod'
import { SCRIPTS } from './recipe'
import { INCUS_SPEC } from './spec'
import { transactionOf } from '../apt'
import { outputOf, tagged, type Section } from '../output'
import { shellCommand } from '../shell'
import { InstallerError } from '../../diagnostic/error'
import { observationSchema, type IncusTarget, type Observation } from './types'
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

const serverSchema = z.looseObject({
  config: settings,
  api_extensions: z.array(z.string()),
  environment: z.looseObject({ server_version: z.string() }),
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
const instanceSchema = z.looseObject({ name: z.string(), status: z.string() })
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
    ipForward: yesNo(values.get('ipForward'), 'IP forwarding'),
  }
}

function repositoryOf(files: Section, madison: Section) {
  const state = (value: string) => {
    const [kind, sha256] = value.split(' ')
    return { kind, sha256: sha256 ?? null }
  }
  const found: Record<string, ReturnType<typeof state>> = {}
  const conflicts: string[] = []
  for (const [tag, value] of tagged(files.lines)) {
    if (tag === 'conflict') {
      conflicts.push(value)
    } else if (tag === 'key' || tag === 'source') {
      found[tag] = state(value)
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
  return { key: found.key, source: found.source, conflicts, candidates }
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

function zfsOf(section: Section) {
  let available = false
  let pool: { name: string; guid: string } | null = null
  const datasets: { name: string; mounted: boolean }[] = []
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
      default:
        throw inspectionFailure('The ZFS inspection reported an unrecognized line.')
    }
  }
  return { available, pool, datasets }
}

/**
 * The API sections exist only when the script judged a daemon socket active.
 * Their absence is a value (`null`), never an empty result.
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
    instances: read('instances', list(instanceSchema)).map(({ name, status }) => ({ name, status })),
    images: read('images', list(imageSchema)).length,
  }
}

/**
 * Runs the fixed inspection and validates its output into one observation.
 * Transport failures propagate unchanged: a failed channel ends the connection,
 * so nothing further runs on it. `target.pool` selects the one ZFS pool whose
 * datasets are reported, and `target.account` the account whose Incus group
 * membership is reported. `approved` names the packages of an approved
 * transaction, so a verification checks all of them and not only the direct
 * ones; they are reported but never simulated. Reading the API of an active
 * socket can start the daemon through socket activation; with inactive sockets
 * the API is not read.
 */
export async function inspectHost(
  remote: Remote,
  target: Pick<IncusTarget, 'pool' | 'account'>,
  approved: readonly string[] = [],
): Promise<Observation> {
  const { repository, network, access, packages, companions, excluded, inspect } = INCUS_SPEC
  const known = new Set<string>([...packages, ...companions, ...excluded])
  const reported = [...companions, ...excluded, ...approved.filter(name => !known.has(name))]
  const command = shellCommand(
    SCRIPTS.inspect,
    [
      target.pool,
      repository.keyFile,
      repository.sourceFile,
      network.subnet,
      target.account,
      access.group,
      ...packages,
      '--',
      ...reported,
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
    repository: repositoryOf(succeeded(found, 'repository'), succeeded(found, 'candidates')),
    packages: installedOf(succeeded(found, 'packages')),
    transaction: transactionOf(simulation, inspectionFailure),
    services: servicesOf(succeeded(found, 'services')),
    listeners: listenersOf(succeeded(found, 'listeners')),
    network: networkOf(succeeded(found, 'network')),
    access: accessOf(succeeded(found, 'access'), target.account),
    zfs: zfsOf(succeeded(found, 'zfs')),
    api: apiOf(found),
  }
  const parsed = observationSchema.safeParse(draft)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join('.') ?? 'observation'
    throw inspectionFailure(`The field ${field} was missing or out of range.`)
  }
  return parsed.data
}
