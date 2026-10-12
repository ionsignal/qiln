import type { DiagnosticFact } from '../../../diagnostic/error'
import { deploymentName } from '../../../aws/deployment/alias'
import { cleanup, phase, type Phase } from '../../../aws/deployment/facts'
import { refusals } from '../../../aws/deployment/step'
import { resourceId, resources, unreleased } from '../../../aws/deployment/topology'
import type { Deployment, Observation, ObservedState } from '../../../aws/deployment/types'
import type { Reporter, Tone } from '../../../terminal/reporter'

interface RecordedState {
  label: string
  tone: Tone
  text: string
}

const OBSERVED_STATES: readonly ObservedState[] = ['present', 'changed', 'absent']

const STATES: Record<Phase, RecordedState> = {
  approved: { label: 'Approved', tone: 'neutral', text: 'Creation was approved, but no provider call was made.' },
  'not-attempted': {
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
  partial: { label: 'Partial', tone: 'warning', text: 'Creation stopped after a verified step; the network is incomplete.' },
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
    text: 'The network was created and observed. It remains until it is removed.',
  },
  removing: { label: 'Partly removed', tone: 'warning', text: 'Removal is partly verified; recorded resources remain.' },
  removed: { label: 'Removed', tone: 'success', text: 'All recorded resources were removed and observed absent.' },
  absent: { label: 'Absent', tone: 'neutral', text: 'All recorded resources were observed absent.' },
}

const RECOVERY: RecordedState = {
  label: 'Recovery required',
  tone: 'danger',
  text: 'A provider child process was not confirmed terminated. No further provider work runs for this deployment until that is resolved.',
}

export function recordedState(record: Deployment): RecordedState {
  return record.termination === 'unconfirmed' ? RECOVERY : STATES[phase(record)]
}

export function observationSummary(observation: Observation): string {
  const counts = OBSERVED_STATES.flatMap(state => {
    const count = observation.resources.filter(resource => resource.state === state).length
    return count > 0 ? [`${count} ${state}`] : []
  })
  return [`${observation.resources.length} recorded`, ...counts].join(' · ')
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
    [
      'Recorded resources',
      `${resources(record).length} retained · ${unreleased(record).length} not confirmed removed`,
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
  if (record.latest?.resources.some(resource => resource.state === 'absent')) {
    reporter.notice('Absence never proves who deleted a resource.')
  }
}
