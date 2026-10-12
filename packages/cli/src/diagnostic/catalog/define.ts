export interface DiagnosticDefinition {
  readonly title: string
  readonly explanation: string
  readonly steps: readonly string[]
}

export function entry(title: string, explanation: string, ...steps: string[]): DiagnosticDefinition {
  return Object.freeze({
    title,
    explanation,
    steps: Object.freeze(steps),
  })
}

export const preservePostgresStep = 'Preserve the PostgreSQL custom volume and its data during any manual recovery.'
