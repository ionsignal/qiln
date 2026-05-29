import { IncusError } from '../errors'

/**
 * A zero-dependency, fail-fast micro-engine for template interpolation.
 * Replaces {{ path.to.variable }} with the corresponding value from the data object.
 *
 * @param template The raw string containing mustache-style template tags.
 * @param data The strictly typed object (usually from Postgres) providing the values.
 * @returns The interpolated string.
 */
export function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, path) => {
    const keys = path.split('.')
    let current: any = data
    for (const key of keys) {
      if (current === undefined || current === null || typeof current !== 'object') {
        throw new IncusError(`Interpolation failed: Missing or invalid variable path '${path}'`, 'VALIDATION_ERROR')
      }
      current = current[key]
    }
    if (current === undefined || current === null || typeof current === 'object') {
      throw new IncusError(`Interpolation failed: Resolved value for '${path}' is invalid (must be a primitive)`, 'VALIDATION_ERROR')
    }
    return String(current)
  })
}
