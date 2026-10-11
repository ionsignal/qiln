import { InstallerError } from '../../../diagnostic/error'
import * as connections from '../../../aws/connection/records'
import { Session } from '../../../aws/auth/session'
import { requireBound } from '../../../aws/deployment/binding'
import { Deployer } from '../../../aws/deployment/deployer'
import { describe, effects } from '../../../aws/deployment/facts'
import * as deployments from '../../../aws/deployment/records'
import type { Deployment, Observation } from '../../../aws/deployment/types'
import type { Dir } from '../../../state/files'
import type { Reporter } from '../../../terminal/reporter'
import { authenticate, requireAvailable } from '../shared'

/** A recorded deployment together with the connection directory that is bound to it. */
export interface Target {
  record: Deployment
  directory: Dir
  region: string
}

export function notFound(id: string): InstallerError {
  return new InstallerError({
    code: 'AWS_DEPLOYMENT_NOT_FOUND',
    facts: [['Deployment', id]],
  })
}

/**
 * The connection is resolved from the record, never from an argument, and must
 * match its immutable bindings rather than just its name.
 */
export async function openTarget(root: Dir, store: Dir, id: string): Promise<Target> {
  const record = await deployments.read(root, id)
  if (!record) {
    throw notFound(id)
  }
  const directory = await connections.open(store, record.connection)
  await requireAvailable(directory)
  const connection = requireBound(await connections.read(directory, record.connection), record)
  return {
    record,
    directory,
    region: connection.region,
  }
}

export async function authenticateDeployer(root: Dir, target: Target, signal: AbortSignal): Promise<Deployer> {
  const session = await Session.open(target.directory, target.region)
  await authenticate(session, target.record.binding.operator, signal)
  return Deployer.open(root, session, target.record)
}

export function observationSummary(observation: Observation): string {
  const vpc = observation.vpc
  if (vpc === null) {
    return 'recorded VPC observed absent'
  }
  return `${vpc.state} · ${vpc.cidr} · ${vpc.tenancy} tenancy · ${vpc.tags.length} tags · ${vpc.extraCidrs} extra CIDR associations`
}

/** Reports persisted facts only; the outcome row is derived, never stored. */
export function reportDeployment(reporter: Reporter, record: Deployment): void {
  const outstanding = effects(record) === 'outstanding'
  reporter.section('AWS deployment')
  reporter.row('verified', 'Deployment', record.id)
  reporter.row('verified', 'Connection', record.connection)
  reporter.row('verified', 'Account', record.binding.accountId)
  reporter.row('verified', 'Operator', record.binding.operator.arn)
  reporter.row('verified', 'Region', record.binding.region)
  reporter.row('verified', 'Approved CIDR', record.approval.cidr)
  reporter.row('verified', 'VPC', record.creation?.returned?.vpcId ?? 'no identity retained')
  reporter.row(outstanding ? 'working' : 'verified', 'Outcome', describe(record))
  reporter.row('verified', 'Removal attempts', String(record.removals.length))
  if (record.latest !== null) {
    reporter.row('verified', 'Last observation', `${record.latest.observedAt} · ${observationSummary(record.latest)}`)
  }
  const failure = (record.removals.at(-1) ?? record.creation)?.failure
  if (failure) {
    reporter.row('verified', 'Last failure', `${failure.code} · ${failure.outcome}`)
  }
  reporter.row(
    record.termination === 'confirmed' ? 'verified' : 'working',
    'Child termination',
    record.termination === 'confirmed' ? 'confirmed' : 'not confirmed',
  )
  if (record.termination === 'unconfirmed') {
    reporter.notice(
      'A provider child process was not confirmed terminated. No further provider work runs for this deployment until that is resolved.',
    )
  }
  if (outstanding) {
    reporter.notice(
      'Resources or unresolved effects may remain. No replay, adoption, deletion, rollback, or automatic recovery was attempted.',
    )
  }
  if (record.latest?.vpc === null) {
    reporter.notice('Absence never proves who deleted the VPC.')
  }
}
