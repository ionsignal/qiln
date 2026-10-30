import type { Failure } from '../output'
import type { Dataset } from './types'

interface Reading {
  value: string
  source: string
}

/**
 * Entries are `name property source value`, where the value is the rest of the
 * line. Source is reduced to its first word by the script, so `inherited from X`
 * reads as `inherited`. Every dataset must report every property: a missing one
 * is malformed output and never reads as a default.
 */
export function datasetsOf(entries: readonly string[], failure: Failure): Dataset[] {
  const found = new Map<string, Map<string, Reading>>()
  for (const entry of entries) {
    const [name, property, source, ...rest] = entry.split(' ')
    if (name === undefined || property === undefined || source === undefined || rest.length === 0) {
      throw failure('A dataset property line was malformed.')
    }
    const readings = found.get(name) ?? new Map<string, Reading>()
    if (readings.has(property)) {
      throw failure('A dataset property was repeated.')
    }
    readings.set(property, { value: rest.join(' '), source })
    found.set(name, readings)
  }
  return [...found].map(([name, readings]) => {
    const read = (property: string): Reading => {
      const reading = readings.get(property)
      if (reading === undefined) {
        throw failure(`A dataset was missing its ${property} property.`)
      }
      return reading
    }
    const mounted = read('mounted').value
    if (mounted !== 'yes' && mounted !== 'no' && mounted !== '-') {
      throw failure('A dataset mount indicator was unrecognized.')
    }
    return {
      name,
      guid: read('guid').value,
      type: read('type').value,
      mountpoint: read('mountpoint'),
      canmount: read('canmount'),
      mounted: mounted === 'yes',
    }
  })
}
