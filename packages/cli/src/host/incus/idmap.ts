import { INCUS_SPEC } from './spec'
import { allocationsSchema, type Allocations, type IdRange, type Observation } from './types'

const KINDS = ['uid', 'gid'] as const
const FILES = { uid: '/etc/subuid', gid: '/etc/subgid' } as const

export function rangeText({ start, count }: IdRange): string {
  return `${start}:${count}`
}

/**
 * The root ranges to record with a baseline. Null means a file was unreadable or
 * lists no root range, so there is nothing to record.
 */
export function allocationsOf(observation: Observation): Allocations | null {
  const parsed = allocationsSchema.safeParse(observation.idmap)
  return parsed.success ? parsed.data : null
}

/**
 * The recorded ranges as `uid|gid:start:count` words. The open script compares
 * them as text against the allocation files.
 */
export function rangeWords(allocations: Allocations): string[] {
  return KINDS.flatMap(kind => allocations[kind].map(range => `${kind}:${rangeText(range)}`))
}

/**
 * Every way the allocation files fall short of what an open needs. A fresh open
 * needs a root range of the minimum size in each file. A preserved open needs
 * every recorded range listed exactly, and extra ranges are permitted. This
 * compares root ranges only and does not establish that every instance mapping
 * is correct. An unreadable file is never evidence.
 */
export function allocationReasons(observation: Observation, retained: Allocations | null): string[] {
  return KINDS.flatMap(kind => {
    const found = observation.idmap[kind]
    if (found === null) {
      return [`${FILES[kind]} could not be read, so its root allocation is not established.`]
    }
    if (retained === null) {
      const { minimum } = INCUS_SPEC.idmap
      return found.some(range => range.count >= minimum)
        ? []
        : [`${FILES[kind]} has no root range of at least ${minimum} IDs, and Qiln never edits it.`]
    }
    const missing = retained[kind].filter(wanted => !found.some(range => rangeText(range) === rangeText(wanted)))
    return missing.length === 0
      ? []
      : [`${FILES[kind]} does not list the recorded root range ${missing.map(rangeText).join(', ')} (start:count), and Qiln never edits it.`]
  })
}
