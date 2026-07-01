import { IncusError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInterpolablePrimitive(value: unknown): value is string | number | boolean | bigint {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
}

/**
 * A zero-dependency, fail-fast micro-engine for template interpolation.
 * Replaces {{ path.to.variable }} with the corresponding primitive value from the data object.
 *
 * @param template The raw string containing mustache-style template tags.
 * @param data The strictly typed object providing interpolation values.
 * @returns The interpolated string.
 */
export function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, variablePath: string) => {
    const keys = variablePath.split('.')
    let current: unknown = data
    for (const key of keys) {
      if (!isRecord(current)) {
        throw new IncusError(`Interpolation failed: Missing or invalid variable path '${variablePath}'`, 'VALIDATION_ERROR')
      }
      current = current[key]
    }
    if (!isInterpolablePrimitive(current)) {
      throw new IncusError(`Interpolation failed: Resolved value for '${variablePath}' is invalid (must be a primitive)`, 'VALIDATION_ERROR')
    }
    return String(current)
  })
}
