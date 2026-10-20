import { InstallerError, type DiagnosticFact, type InstallerErrorCode, type InstallerErrorOptions } from '../diagnostic/error'

export type SshFailureKind = 'connection' | 'host-key' | 'authentication' | 'command' | 'cancelled'

const CODES = {
  connection: 'SSH_CONNECTION_FAILED',
  'host-key': 'SSH_HOST_KEY_MISMATCH',
  authentication: 'SSH_AUTHENTICATION_FAILED',
  command: 'SSH_COMMAND_FAILED',
  cancelled: 'COMMAND_CANCELLED',
} as const satisfies Record<SshFailureKind, InstallerErrorCode>

export interface SshErrorOptions {
  kind: SshFailureKind
  commandStarted?: boolean
  facts?: readonly DiagnosticFact[]
}

function describe({ kind, commandStarted = false, facts = [] }: SshErrorOptions): InstallerErrorOptions {
  const details: DiagnosticFact[] = [['Failure category', kind], ...facts]
  if (commandStarted) {
    // Closing the connection does not prove that the remote command stopped.
    details.push(['Remote outcome', 'uncertain; the command may have started, and its effects were not confirmed or undone'])
  }
  return {
    code: CODES[kind],
    facts: details,
  }
}

/**
 * Remote uncertainty is reported here, separately from the termination of any
 * local AWS child process. Only authored facts are carried, never library or
 * server messages.
 */
export class SshError extends InstallerError {
  public readonly kind: SshFailureKind
  public readonly commandStarted: boolean

  constructor(options: SshErrorOptions) {
    super(describe(options))
    this.kind = options.kind
    this.commandStarted = options.commandStarted ?? false
  }
}
