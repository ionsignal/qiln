import { InstallerError, type DiagnosticFact } from '../../diagnostic/error'
import * as connections from '../../aws/connection/records'
import { diagnostic } from '../../aws/errors'
import { authRecovery, iamRecovery, terminationConfirmed } from '../../aws/recovery'
import { pendingFacts } from '../../aws/iam/facts'
import { requireAuthentication } from '../../aws/auth/identity'
import { removeAuth, Session } from '../../aws/auth/session'
import type { Pending } from '../../aws/iam/types'
import type { AwsAuthentication, AwsConnection, AwsIdentity } from '../../aws/types'
import type { Dir } from '../../state/files'
import type { Reporter } from '../../terminal/reporter'

export function reportAuthentication(reporter: Reporter, authentication: AwsAuthentication): void {
  reporter.row('verified', 'AWS account', authentication.identity.accountId)
  reporter.row('verified', 'Operator', authentication.identity.arn)
  reporter.row('verified', 'User identity', authentication.identity.userId)
  reporter.row('verified', 'Authentication', 'signed in · credentials refresh automatically')
}

export function pendingFailure(record: Pending): never {
  throw iamRecovery(
    new InstallerError({
      code: 'AWS_PERMISSION_RECORDED',
    }),
    {
      termination: record.termination === 'confirmed',
      cleanup: record.cleanup === 'completed',
      journal: true,
    },
    pendingFacts(record),
    record.kind === 'maintain',
  )
}

export async function requireAvailable(directory: Dir): Promise<void> {
  const pending = await connections.pending(directory)
  if (pending) {
    return pendingFailure(pending)
  }
}

export async function failAuthentication(directory: Dir, name: string, cause: unknown): Promise<never> {
  const failure = diagnostic(cause)
  const terminated = terminationConfirmed(cause)
  let cleanup = false
  if (terminated) {
    try {
      await removeAuth(directory)
      cleanup = true
    } catch {
      cleanup = false
    }
  }
  let inspected = true
  const facts: DiagnosticFact[] = []
  try {
    const saved = await connections.read(directory, name)
    facts.push([
      'Connection binding',
      saved
        ? `retained for ${saved.identity.arn}; authentication cleanup does not roll back the binding`
        : 'absent when inspected',
    ])
  } catch {
    inspected = false
    facts.push(['Connection binding', 'persistence or inspection not confirmed; inspect retained state'])
  }
  throw authRecovery(
    new InstallerError({
      code: failure.code,
      facts: [...failure.facts, ...facts],
      retry: failure.retry,
    }),
    {
      termination: terminated,
      cleanup,
      journal: inspected,
    },
    `qiln aws connect --name ${name}`,
  )
}

export function reportPermissionMetadata(reporter: Reporter, connection: AwsConnection): void {
  const managed = connection.managed
  if (!managed) {
    reporter.info('This connection is authentication-only. No Qiln-managed IAM ownership is inferred from its name.')
    return
  }
  reporter.row('verified', 'Permission region', managed.permissionRegion)
  reporter.row('verified', 'Foundation binding', managed.foundation?.arn ?? 'not enrolled')
  if (managed.foundation) {
    reporter.row('verified', 'Policy identity', managed.foundation.id)
  }
  if (managed.verified) {
    reporter.row('verified', 'Recorded requirement', String(managed.verified.version))
    reporter.row('verified', 'Recorded version', managed.verified.policyVersion)
    reporter.row('verified', 'Recorded SHA-256', managed.verified.sha256)
    reporter.row('verified', 'Last verification', managed.verified.verifiedAt)
  } else {
    reporter.info('No completed foundation verification is recorded.')
  }
  reporter.info('These are retained bindings and last-verified metadata, not a fresh inspection of live IAM.')
}

export async function authenticate(
  session: Session,
  expected: AwsIdentity,
  signal: AbortSignal,
): Promise<AwsAuthentication> {
  const authentication = await session.verify(signal)
  requireAuthentication(authentication, expected)
  return authentication
}
