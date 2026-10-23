import { z } from 'zod'
import { InstallerError } from '../../diagnostic/error'
import type { BlockDevice } from './types'

export interface Section {
  status: number
  lines: string[]
}

/**
 * Carries only authored wording. Raw output, device names, and tool messages
 * never enter the diagnostic.
 */
export function inspectionFailure(reason: string): InstallerError {
  return new InstallerError({
    code: 'ZFS_INSPECTION_FAILED',
    facts: [['Reason', reason]],
  })
}

const BEGIN = /^#qiln:begin (\w+)$/
const END = /^#qiln:end (\w+) ([0-9]+)$/

/**
 * Splits the script output into its named sections. Anything outside a section
 * is ignored, and unbalanced or repeated sections are refused.
 */
export function sections(output: string): Map<string, Section> {
  const found = new Map<string, Section>()
  let open: { name: string; lines: string[] } | null = null
  for (const line of output.split('\n')) {
    const begin = BEGIN.exec(line)
    const end = END.exec(line)
    if (begin !== null) {
      if (open !== null || found.has(begin[1])) {
        throw inspectionFailure('The inspection output is malformed.')
      }
      open = { name: begin[1], lines: [] }
    } else if (end !== null) {
      if (open === null || open.name !== end[1]) {
        throw inspectionFailure('The inspection output is malformed.')
      }
      found.set(open.name, { status: Number(end[2]), lines: open.lines })
      open = null
    } else if (open !== null) {
      open.lines.push(line)
    }
  }
  if (open !== null) {
    throw inspectionFailure('The inspection output ended inside a section.')
  }
  return found
}

/**
 * Lines of the form `tag value`, where the value is the rest of the line.
 */
export function tagged(lines: readonly string[]): [string, string][] {
  return lines
    .filter(line => line !== '')
    .map((line): [string, string] => {
      const space = line.indexOf(' ')
      return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]
    })
}

/**
 * Tagged lines whose tags must be unique.
 */
export function fields(lines: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (const [tag, value] of tagged(lines)) {
    if (values.has(tag)) {
      throw inspectionFailure('The inspection output repeats a field.')
    }
    values.set(tag, value)
  }
  return values
}

/**
 * lsblk prints every requested column for every device, using null when a
 * value is empty. A missing key is therefore malformed output, never an empty
 * value. Only `children` is omitted by lsblk for a device without any.
 */
interface RawBlock {
  name: string
  type: string
  size: number | string
  serial: string | null
  model: string | null
  'log-sec': number | string | null
  'phy-sec': number | string | null
  fstype: string | null
  mountpoints: (string | null)[] | null
  children?: RawBlock[] | undefined
}

/**
 * Different util-linux versions print byte counts as numbers or as strings.
 */
const number = z.union([z.number(), z.string()])

const rawBlock: z.ZodType<RawBlock> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string(),
    size: number,
    serial: z.string().nullable(),
    model: z.string().nullable(),
    'log-sec': number.nullable(),
    'phy-sec': number.nullable(),
    fstype: z.string().nullable(),
    mountpoints: z.array(z.string().nullable()).nullable(),
    children: z.array(rawBlock).optional(),
  }),
)

const lsblkSchema = z.object({
  blockdevices: z.array(rawBlock),
})

function wholeNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null
  }
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : null
}

function deviceOf(raw: RawBlock): BlockDevice {
  const size = wholeNumber(raw.size)
  if (size === null) {
    throw inspectionFailure('A block device reported no usable size.')
  }
  return {
    path: raw.name,
    type: raw.type,
    sizeBytes: size,
    serial: raw.serial?.trim() || null,
    model: raw.model?.trim() || null,
    logicalSector: wholeNumber(raw['log-sec']),
    physicalSector: wholeNumber(raw['phy-sec']),
    filesystem: raw.fstype,
    mountpoints: (raw.mountpoints ?? []).filter((mountpoint): mountpoint is string => mountpoint !== null),
    children: (raw.children ?? []).map(deviceOf),
  }
}

export function blockDevices(json: string): BlockDevice[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw inspectionFailure('The disk listing was not valid JSON.')
  }
  const parsed = lsblkSchema.safeParse(value)
  if (!parsed.success) {
    throw inspectionFailure('The disk listing was not in the expected form.')
  }
  return parsed.data.blockdevices.map(deviceOf)
}
