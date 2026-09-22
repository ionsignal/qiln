import { catalog } from './catalog'

export type InstallerErrorCode = keyof typeof catalog

export type DiagnosticFact = readonly [label: string, value: string]

export interface InstallerErrorOptions {
  code: InstallerErrorCode
  facts?: readonly DiagnosticFact[]
  retry?: string
}

/**
 * Producers provide safe facts, not presentation policy or raw provider errors.
 * Terminal sanitization is deferred so the diagnostic retains exact
 * identities.
 */
export class InstallerError extends Error {
  public readonly code: InstallerErrorCode
  public readonly facts: readonly DiagnosticFact[]
  public readonly retry: string | undefined

  constructor(options: InstallerErrorOptions) {
    super(catalog[options.code].title)
    this.name = 'InstallerError'
    this.code = options.code
    this.facts = Object.freeze((options.facts ?? []).map(([label, value]) => Object.freeze([label, value] as const)))
    this.retry = options.retry
  }
}
