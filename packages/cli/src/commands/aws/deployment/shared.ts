import { InstallerError } from '../../../diagnostic/error'
import * as connections from '../../../aws/connection/records'
import { Session } from '../../../aws/auth/session'
import { requireBound } from '../../../aws/deployment/binding'
import { Deployer } from '../../../aws/deployment/deployer'
import { describe, effects } from '../../../aws/deployment/facts'
import * as deployments from '../../../aws/deployment/records'
import { refusals } from '../../../aws/deployment/step'
import { resourceId, resources, unreleased } from '../../../aws/deployment/topology'
import type { Deployment, Observation, ObservedState } from '../../../aws/deployment/types'
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
  const count = (state: ObservedState) => observation.resources.filter(resource => resource.state === state).length
  return `${observation.resources.length} recorded resources · ${count('present')} present · ${count('changed')} changed · ${count('absent')} absent`
}

/** Reports persisted facts only; the outcome row is derived, never stored. */
export function reportDeployment(reporter: Reporter, record: Deployment): void {
  const outstanding = effects(record) === 'outstanding'
  const failure = record.steps.findLast(step => step.failure !== null)
  reporter.section('AWS deployment')
  reporter.row('verified', 'Deployment', record.id)
  reporter.row('verified', 'Connection', record.connection)
  reporter.row('verified', 'Account', record.binding.accountId)
  reporter.row('verified', 'Operator', record.binding.operator.arn)
  reporter.row('verified', 'Region', record.binding.region)
  reporter.row('verified', 'Approved CIDR', record.approval.cidr)
  reporter.row('verified', 'Zones', record.approval.zones.map(zone => zone.name).join(', '))
  reporter.row('verified', 'Administrator CIDR', record.approval.ingress[0].cidr)
  reporter.row('verified', 'VPC', resourceId(record, 'create-vpc') ?? 'no identity retained')
  reporter.row(
    'verified',
    'Recorded resources',
    `${resources(record).length} retained · ${unreleased(record).length} not confirmed removed`,
  )
  reporter.row(outstanding ? 'working' : 'verified', 'Outcome', describe(record))
  reporter.row('verified', 'Recorded steps', String(record.steps.length))
  reporter.row('verified', 'Removal attempts', String(record.removals.length))
  reporter.row('verified', 'Refused removals', String(refusals(record.steps)))
  if (record.latest !== null) {
    reporter.row('verified', 'Last observation', `${record.latest.observedAt} · ${observationSummary(record.latest)}`)
  }
  if (failure?.failure) {
    reporter.row('verified', 'Last failure', `${failure.action} · ${failure.failure.code} · ${failure.failure.outcome}`)
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
  reporter.space()
  if (outstanding) {
    reporter.notice(
      'Resources or unresolved effects may remain. No replay, adoption, deletion, rollback, or automatic recovery was attempted.',
    )
  }
  if (record.latest?.resources.some(resource => resource.state === 'absent')) {
    reporter.notice('Absence never proves who deleted a resource.')
  }
}
