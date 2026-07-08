export function detailsFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (value === undefined || value === null) {
    return undefined
  }
  return {
    value,
  }
}
