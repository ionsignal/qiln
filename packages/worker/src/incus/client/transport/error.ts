function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function messageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'string' && error.trim() !== '') {
    return error
  }
  return 'Unknown Incus transport failure'
}

export function detailsFromUnknown(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    }
  }
  if (isRecord(error)) {
    return error
  }
  return {
    value: error,
  }
}
