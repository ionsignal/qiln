import { z } from 'zod'
import { ZFS_SPEC } from './spec'
import { SCRIPTS } from './recipe'
import { blockDevices, inspectionFailure } from './parse'
import { transactionOf } from '../apt'
import { outputOf, tagged, type Section } from '../output'
import { shellCommand } from '../shell'
import { observationSchema, type Observation } from './types'
import type { Remote } from '../../ssh/connections'

const { fields, required, sections, succeeded, yesNo } = outputOf(inspectionFailure)

/**
 * Pool-level keys under which `zpool status -j` reports the classes that the
 * supported layout never has. Their mere presence is reported, because an
 * unsupported class must refuse rather than disappear in the schema.
 */
const AUXILIARY_CLASSES = ['logs', 'l2cache', 'spares', 'special', 'dedup'] as const

interface RawVdev {
  path?: string | undefined
  name?: string | undefined
  vdevs?: Record<string, RawVdev> | undefined
  vdev_type: string
}

const vdevSchema: z.ZodType<RawVdev> = z.lazy(() =>
  z.object({
    path: z.string().optional(),
    name: z.string().optional(),
    vdevs: z.record(z.string(), vdevSchema).optional(),
    vdev_type: z.string(),
  }),
)

/**
 * Only the fields that verification reads, and only the output version that was
 * reviewed. Any other shape stops the command. A pool entry keeps its other
 * keys so the auxiliary classes can be detected.
 */
const statusSchema = z.object({
  output_version: z.object({
    command: z.literal('zpool status'),
    vers_major: z.literal(0),
  }),
  pools: z.record(z.string(), z.looseObject({ vdevs: z.record(z.string(), vdevSchema) })),
})

function runningLimit(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw inspectionFailure('The ARC inspection reported a running limit that is not a whole number.')
  }
  return Number(value)
}

function ashiftOf(value: string): number {
  if (!/^[0-9]{1,2}$/.test(value)) {
    throw inspectionFailure('The pool inspection reported an alignment that is not a whole number.')
  }
  return Number(value)
}

function systemOf(section: Section) {
  const values = fields(section.lines)
  return {
    kernel: values.get('kernel'),
    architecture: values.get('machine'),
    packageArchitecture: values.get('packageArchitecture'),
    memoryBytes: Number(values.get('memTotalKiB')) * 1_024,
    rebootRequired: yesNo(values.get('rebootRequired'), 'reboot'),
  }
}

/**
 * A failed section means no module metadata, which is a prerequisite outcome
 * rather than an inspection failure.
 */
function moduleOf(section: Section) {
  if (section.status !== 0) {
    return null
  }
  const values = fields(section.lines)
  return {
    path: values.get('filename'),
    version: values.get('version'),
    vermagic: values.get('vermagic'),
    package: values.get('package') || null,
    loaded: yesNo(values.get('loaded'), 'module loaded'),
  }
}

function packagesOf(section: Section) {
  return section.lines
    .filter(line => line !== '')
    .map(line => {
      const [name, version, architecture, state] = line.split(' ')
      return { name, version, architecture, installed: state === 'installed' }
    })
}

function signaturesOf(section: Section) {
  const probes = new Map<string, { path: string; exitCode: number; fields: Record<string, string> }>()
  for (const [path, value] of tagged(section.lines)) {
    const probe = probes.get(path) ?? { path, exitCode: Number.NaN, fields: {} }
    probes.set(path, probe)
    if (value.startsWith('#exit ')) {
      probe.exitCode = Number(value.slice('#exit '.length))
      continue
    }
    const separator = value.indexOf('=')
    if (separator < 1) {
      throw inspectionFailure('A signature probe reported an unrecognized line.')
    }
    probe.fields[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return [...probes.values()]
}

function arcOf(section: Section) {
  let present = false
  const owned: string[] = []
  const conflicts: string[] = []
  let runningMax: number | null = null
  let runningMin: number | null = null
  for (const [tag, value] of tagged(section.lines)) {
    switch (tag) {
      case 'owned-present':
        present = yesNo(value, 'ARC file')
        break
      case 'owned-line': {
        const line = value.trim()
        if (line !== '') {
          owned.push(line)
        }
        break
      }
      case 'conflict':
        conflicts.push(value)
        break
      case 'cmdline':
        conflicts.push(`kernel command line ${value}`)
        break
      case 'running-max':
        runningMax = runningLimit(value)
        break
      case 'running-min':
        runningMin = runningLimit(value)
        break
      default:
        throw inspectionFailure('The ARC inspection reported an unrecognized line.')
    }
  }
  return { ownedLines: present ? owned : null, conflicts, runningMax, runningMin }
}

function poolsOf(section: Section) {
  let tools = false
  let moduleLoaded = false
  const imported: { name: string; guid: string }[] = []
  for (const [tag, value] of tagged(section.lines)) {
    switch (tag) {
      case 'tools':
        tools = yesNo(value, 'pool tools')
        break
      case 'loaded':
        moduleLoaded = yesNo(value, 'pool module loaded')
        break
      case 'pool': {
        const [name, guid] = value.split(' ')
        imported.push({ name, guid })
        break
      }
      default:
        throw inspectionFailure('The pool inspection reported an unrecognized line.')
    }
  }
  return { tools, moduleLoaded, imported }
}

function detailOf(status: Section, properties: Section, name: string) {
  let json: unknown
  try {
    json = JSON.parse(status.lines.join('\n'))
  } catch {
    throw inspectionFailure('The pool status was not valid JSON.')
  }
  const parsed = statusSchema.safeParse(json)
  const entry = parsed.success ? Object.entries(parsed.data.pools).find(([key]) => key === name)?.[1] : undefined
  if (entry === undefined) {
    throw inspectionFailure('The pool status was not in the expected form.')
  }
  const [only, ...rest] = Object.entries(entry.vdevs)
  const root = only !== undefined && rest.length === 0 ? only[1] : undefined
  if (root === undefined) {
    throw inspectionFailure('The pool status did not describe exactly one root vdev.')
  }
  const data = Object.entries(root.vdevs ?? {}).map(([key, vdev]) => ({
    type: vdev.vdev_type,
    path: vdev.path ?? vdev.name ?? key,
    children: Object.keys(vdev.vdevs ?? {}).length,
  }))
  const auxiliary = AUXILIARY_CLASSES.filter(auxiliaryClass => Object.hasOwn(entry, auxiliaryClass))
  const pool: Record<string, string> = {}
  const dataset: Record<string, string> = {}
  const ashifts: number[] = []
  const mounted: string[] = []
  for (const [tag, value] of tagged(properties.lines)) {
    if (tag === 'ashift') {
      ashifts.push(ashiftOf(value))
      continue
    }
    if (tag === 'mounted') {
      mounted.push(value)
      continue
    }
    const separator = value.indexOf(' ')
    if ((tag !== 'pool' && tag !== 'dataset') || separator < 1) {
      throw inspectionFailure('The pool inspection reported an unrecognized property line.')
    }
    const properties = tag === 'pool' ? pool : dataset
    properties[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return { data, auxiliary, ashifts, mounted, pool, dataset }
}

function timerOf(section: Section) {
  const values = fields(section.lines)
  return {
    enablement: values.get('enablement'),
    activation: values.get('activation'),
  }
}

function unitsOf(section: Section) {
  return section.lines
    .filter(line => line.trim() !== '')
    .map(line => {
      const [name, state] = line.trim().split(/\s+/)
      return { name, state }
    })
}

/**
 * Runs the fixed read-only inspection and validates its output into one
 * observation. Transport failures propagate unchanged: a failed channel ends
 * the connection, so nothing further runs on it. `poolName` selects the one
 * pool whose status, properties, and scrub timer are reported. `extraPackages`
 * only adds installed-state reports, so a verification can check an approved
 * transaction without widening what the planner simulates.
 */
export async function inspectHost(
  remote: Remote,
  poolName: string,
  extraPackages: readonly string[] = [],
): Promise<Observation> {
  const extras = extraPackages.filter(name => !ZFS_SPEC.packages.some(direct => direct === name))
  const command = shellCommand(
    SCRIPTS.inspect,
    [poolName, ZFS_SPEC.arc.file, ...ZFS_SPEC.packages, '--', ...extras],
    { privileged: true },
  )
  const result = await remote.exec(command, ZFS_SPEC.inspect)
  if (result.exitCode !== 0) {
    throw inspectionFailure(`The inspection script exited with code ${result.exitCode}.`)
  }
  const found = sections(result.stdout)
  const pools = poolsOf(succeeded(found, 'pools'))
  const imported = pools.imported.some(pool => pool.name === poolName)
  const draft = {
    observedAt: new Date().toISOString(),
    system: systemOf(succeeded(found, 'system')),
    module: moduleOf(required(found, 'module')),
    packages: packagesOf(succeeded(found, 'packages')),
    transaction: transactionOf(required(found, 'simulation'), inspectionFailure),
    disks: blockDevices(succeeded(found, 'disks').lines.join('\n')),
    signatures: signaturesOf(succeeded(found, 'signatures')),
    arc: arcOf(succeeded(found, 'arc')),
    pools: {
      ...pools,
      detail: imported ? detailOf(succeeded(found, 'poolstatus'), succeeded(found, 'poolprops'), poolName) : null,
    },
    timer: timerOf(succeeded(found, 'timer')),
    units: unitsOf(succeeded(found, 'units')),
  }
  const parsed = observationSchema.safeParse(draft)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join('.') ?? 'observation'
    throw inspectionFailure(`The field ${field} was missing or out of range.`)
  }
  return parsed.data
}
