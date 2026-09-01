const MAX_DIAGNOSTIC_FIELD_LENGTH = 2_000

export interface QilnInstallerErrorOptions {
  code: string
  check: string
  summary: string
  observed: string
  reason: string
  operatorAction: string
  rerun: string
  cause?: unknown
}

function normalizeDiagnosticField(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH) || 'Not available.'
}

export class QilnInstallerError extends Error {
  public readonly code: string
  public readonly check: string
  public readonly observed: string
  public readonly reason: string
  public readonly operatorAction: string
  public readonly rerun: string

  constructor(options: QilnInstallerErrorOptions) {
    super(
      normalizeDiagnosticField(options.summary),
      options.cause === undefined
        ? undefined
        : {
            cause: options.cause,
          },
    )
    this.name = 'QilnInstallerError'
    this.code = normalizeDiagnosticField(options.code)
    this.check = normalizeDiagnosticField(options.check)
    this.observed = normalizeDiagnosticField(options.observed)
    this.reason = normalizeDiagnosticField(options.reason)
    this.operatorAction = normalizeDiagnosticField(options.operatorAction)
    this.rerun = normalizeDiagnosticField(options.rerun)
  }
}
