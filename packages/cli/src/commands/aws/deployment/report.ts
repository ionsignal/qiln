import type { DiagnosticFact } from '../../../diagnostic/error'
import { deploymentName } from '../../../aws/deployment/alias'
import { cleanup, phase, type Phase } from '../../../aws/deployment/facts'
import type { Disposition } from '../../../aws/deployment/graph'
import { removalOutcome } from '../../../aws/deployment/outcome'
import { refusals } from '../../../aws/deployment/step'
import { released, resourceId, resources, retained, unreleased, type Resource } from '../../../aws/deployment/topology'
import type { Deployment, Observation, ObservedState } from '../../../aws/deployment/types'
import type { Reporter, TableCell, Tone } from '../../../terminal/reporter'

interface RecordedState {
  label: string
  tone: Tone
  text: string
}

const OBSERVED_STATES: readonly ObservedState[] = ['present', 'changed', 'absent']
const LIFECYCLES: Record<Disposition, string> = {
  removed: 'removed by Qiln',
  retained: 'retained by design',
  implicit: 'deleted with the instance',
}
const RECOVERY: RecordedState = {
  label: 'Recovery required',
  tone: 'danger',
  text: 'A provider child process was not confirmed terminated. No further provider work runs for this deployment until that is resolved.',
}
const STATES: Record<Phase, RecordedState> = {
  approved: { label: 'Approved', tone: 'neutral', text: 'Creation was approved, but no provider call was made.' },
  unattempted: {
    label: 'Not attempted',
    tone: 'warning',
    text: 'The last mutation was refused before dispatch, so it changed nothing.',
  },
  rejected: { label: 'Rejected', tone: 'warning', text: 'AWS definitively refused the last mutation.' },
  blocked: {
    label: 'Blocked',
    tone: 'warning',
    text: 'AWS refused the last removal step because dependent resources remain.',
  },
  returned: {
    label: 'Unverified',
    tone: 'warning',
    text: 'The last response was retained but has not been verified by observation.',
  },
  partial: { label: 'Partial', tone: 'warning', text: 'Creation stopped after a verified step; the deployment is incomplete.' },
  unresolved: {
    label: 'Uncertain',
    tone: 'danger',
    text: 'A mutation was fenced but its outcome is unknown. It is never repeated.',
  },
  uncertain: {
    label: 'Uncertain',
    tone: 'danger',
    text: 'The outcome of the last mutation is unknown. It is never repeated.',
  },
  created: {
    label: 'Created',
    tone: 'success',
    text: 'The recorded resources were created and observed. They remain until they are removed.',
  },
  removing: { label: 'Partly removed', tone: 'warning', text: 'Removal is partly verified; recorded resources remain.' },
  removed: { label: 'Removed', tone: 'success', text: 'All recorded resources were removed and observed absent.' },
  retained: {
    label: 'Retained storage',
    tone: 'warning',
    text: 'Removal was verified. Resources retained by design remain, are not removed by Qiln, and continue to incur charges until they are deleted outside Qiln.',
  },
  absent: { label: 'Absent', tone: 'neutral', text: 'All recorded resources were observed absent.' },
}

export function recordedState(record: Deployment): RecordedState {
  return record.termination === 'unconfirmed' ? RECOVERY : STATES[phase(record)]
}

export function lifecycleOf(resource: Resource): string {
  return LIFECYCLES[resource.disposition]
}

export function observationSummary(observation: Observation): string {
  const counts = OBSERVED_STATES.flatMap(state => {
    const count = observation.resources.filter(resource => resource.state === state).length
    return count > 0 ? [`${count} ${state}`] : []
  })
  return [`${observation.resources.length} recorded`, ...counts].join(' · ')
}

function recordedOutcome(record: Deployment, resource: Resource): TableCell {
  if (released(record, resource)) {
    return 'observed absent'
  }
  return resource.disposition === 'retained'
    ? { text: 'retained; not removed by Qiln', tone: 'warning' }
    : 'not confirmed removed'
}

function reportResources(reporter: Reporter, record: Deployment): void {
  const recorded = resources(record)
  if (recorded.length === 0) {
    return
  }
  reporter.section('Resources')
  reporter.table(
    ['Kind', 'ID', 'Lifecycle', 'Recorded outcome'],
    recorded.map((resource): TableCell[] => [
      resource.kind,
      resource.id,
      lifecycleOf(resource),
      recordedOutcome(record, resource),
    ]),
  )
}

export function reportDeployment(reporter: Reporter, record: Deployment): void {
  const state = recordedState(record)
  const current = phase(record)
  const historical = resources(record).length > 0 && unreleased(record).length === 0
  const unresolved = record.termination === 'unconfirmed' || current === 'unresolved' || current === 'uncertain'
  const facts: DiagnosticFact[] = [
    ['Deployment', record.id],
    ['Name', deploymentName(record.alias)],
    ['Connection', record.connection],
    ['Account', record.binding.accountId],
    ['Operator', record.binding.operator.arn],
    ['Region', record.binding.region],
    ['Approved CIDR', record.approval.cidr],
    ['Zones', record.approval.zones.map(zone => zone.name).join(', ')],
    ['Administrator CIDR', record.approval.ingress[0].cidr],
    [historical ? 'VPC (historical)' : 'VPC', resourceId(record, 'create-vpc') ?? 'no identity retained'],
    ['Instance', resourceId(record, 'run-instances') ?? 'no identity retained'],
    [
      'Recorded resources',
      `${resources(record).length} recorded · ${unreleased(record).length} not confirmed removed · ${retained(record).length} retained by design`,
    ],
    ['Recorded steps', String(record.steps.length)],
  ]
  if (record.removals.length > 0) {
    facts.push(['Removal attempts', String(record.removals.length)], ['Refused removals', String(refusals(record.steps))])
  }
  if (record.latest !== null) {
    facts.push(['Last observation', `${record.latest.observedAt} · ${observationSummary(record.latest)}`])
  }
  const failed = record.steps.findLast(step => step.failure !== null)
  if (failed?.failure) {
    facts.push(['Last failure', `${failed.action} · ${failed.failure.code} · ${failed.failure.outcome}`])
  }
  if (record.termination === 'unconfirmed') {
    facts.push(['Child termination', 'not confirmed'])
  }
  const plan = cleanup(record)
  if (plan.status !== 'not-needed') {
    facts.push(['Cleanup', `${plan.status}: ${plan.detail}`])
  }
  reporter.section('AWS deployment')
  reporter.state('Recorded state', state.label, state.tone)
  reporter.space()
  reporter.facts(facts)
  reporter.space()
  reporter.info(state.text)
  if (unresolved) {
    reporter.notice(
      'Resources or unresolved effects may remain. No replay, adoption, deletion, rollback, or automatic recovery was attempted.',
    )
  }
  if (retained(record).length > 0) {
    reporter.notice(
      'Retained resources are never deleted by Qiln. They keep incurring charges for as long as they exist, including after the instance is terminated, until they are deleted outside Qiln.',
    )
  }
  if (record.latest?.resources.some(resource => resource.state === 'absent')) {
    reporter.notice('Absence never proves who deleted a resource.')
  }
  reportResources(reporter, record)
  if (record.removals.length > 0) {
    reporter.section('Removal outcome')
    reporter.facts(removalOutcome(record).map((row): DiagnosticFact => [row.label, `${row.state} · ${row.detail}`]))
  }
}
