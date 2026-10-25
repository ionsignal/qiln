import { join } from 'node:path'
import { AWS_SPEC } from '../../aws/spec'
import { POLICY_KEYS } from '../../aws/permission/keys'
import { diagnostic } from '../../aws/errors'
import { pendingFacts } from '../../aws/iam/facts'
import { InstallerError, type DiagnosticFact } from '../../diagnostic/error'
import { deploymentFacts, effects } from '../../aws/deployment/facts'
import { requireStorageSettled } from '../../aws/deployment/incus/facts'
import { requirePoolSettled } from '../../aws/deployment/zfs/facts'
import { authRecovery, deploymentRecovery, iamRecovery, terminationConfirmed } from '../../aws/recovery'
import { requireAuthentication } from '../../aws/auth/identity'
import { removeAuth, Session } from '../../aws/auth/session'
import { withAwsOperation, type AwsState } from '../../aws/root'
import { evidence as incusEvidence } from '../../aws/deployment/incus/evidence'
import * as connections from '../../aws/connection/records'
import * as deployments from '../../aws/deployment/records'
import * as lineage from '../../aws/deployment/zfs/lineage'
import type { Pending } from '../../aws/iam/types'
import type { Deployment } from '../../aws/deployment/types'
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

/**
 * Unconfirmed child termination is sticky. Refusing before any authentication
 * keeps further child work from starting, and the error's unconfirmed
 * termination makes the outer operation retain its lock. Nothing here clears
 * the recorded termination.
 */
async function requireConfirmedTermination(root: Dir): Promise<void> {
  const active = (await deployments.list(root)).find(record => record.termination === 'unconfirmed')
  if (active === undefined) {
    return
  }
  throw deploymentRecovery(
    new InstallerError({
      code: 'AWS_DEPLOYMENT_RECOVERY_REQUIRED',
    }),
    {
      termination: false,
      persistence: true,
    },
    deploymentFacts(active),
    `qiln aws deployment status --id ${active.id}`,
  )
}

/**
 * The AWS-operation lock plus the sticky-termination check. Commands that
 * authenticate or start children use this instead of `withAwsOperation`.
 */
export async function withConfirmedOperation<T>(create: boolean, run: (state: AwsState) => Promise<T>): Promise<T> {
  return await withAwsOperation(create, async state => {
    await requireConfirmedTermination(state.root)
    return await run(state)
  })
}

/**
 * Local removal discards the managed binding, so it is refused while retained
 * deployment evidence indicates that resources or unresolved effects may remain,
 * including an unsettled pool-affecting ZFS step or storage-affecting Incus
 * step. Returns the settled deployments, which stay on disk after removal.
 */
export async function requireSettledDeployments(root: Dir, identity: AwsIdentity): Promise<Deployment[]> {
  const bound = await deployments.bound(root, identity)
  const outstanding = bound.filter(record => effects(record) === 'outstanding')
  const first = outstanding[0]
  if (first !== undefined) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_RECORDED',
      facts: [
        ...deploymentFacts(first),
        ['Retained evidence', join(root.child(AWS_SPEC.state.deployments), first.id, AWS_SPEC.state.deployment)],
        [
          'Preservation',
          'Keep this record and the connection record. Deleting local state does not remove AWS resources and is not recovery.',
        ],
        ['Outstanding deployments', String(outstanding.length)],
      ],
      retry: `qiln aws deployment status --id ${first.id}`,
    })
  }
  for (const record of bound) {
    requirePoolSettled(await lineage.evidence(root, record), record.id)
    requireStorageSettled(await incusEvidence(root, record), record.id)
  }
  return bound
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
  const verified = managed.verified
  reporter.row('verified', 'Deployment region', managed.deploymentRegion)
  for (const key of POLICY_KEYS) {
    const policy = managed.policies[key]
    if (policy === undefined) {
      reporter.row('working', `${key} policy`, 'not enrolled; review required')
      continue
    }
    reporter.row('verified', `${key} policy`, `${policy.arn} (ID ${policy.id})`)
  }
  reporter.row('verified', 'Recorded requirement', String(verified.version))
  reporter.row('verified', 'Recorded SHA-256', verified.sha256)
  for (const key of POLICY_KEYS) {
    const policy = verified.policies[key]
    if (policy !== undefined) {
      reporter.row('verified', `${key} version`, `${policy.policyVersion} · ${policy.sha256}`)
    }
  }
  reporter.row('verified', 'Last verification', verified.verifiedAt)
  reporter.space()
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
