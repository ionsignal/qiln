import { deploymentName } from '../../../aws/deployment/alias'
import {
  cleanup,
  healthDisclosure,
  hostKeyDisclosure,
  keyDisclosure,
  launchDisclosure,
  phase,
  volumeDisclosure,
  type Phase,
} from '../../../aws/deployment/facts'
import {
  incusFacts,
  retainedPreseed,
  storageReleased,
  unsettled as incusUnsettled,
} from '../../../aws/deployment/incus/facts'
import { removalOutcome } from '../../../aws/deployment/outcome'
import { refusals } from '../../../aws/deployment/step'
import { prepared, unsettled, zfsFacts } from '../../../aws/deployment/zfs/facts'
import { released, resourceId, resources, retained, unreleased, type Resource } from '../../../aws/deployment/topology'
import type { IncusRecord } from '../../../aws/deployment/incus/types'
import type { ZfsRecord } from '../../../aws/deployment/zfs/types'
import type { Disposition } from '../../../aws/deployment/graph'
import type { DiagnosticFact } from '../../../diagnostic/error'
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
  'handed-off': 'handed off to a later deployment',
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
    text: 'The last mutation was refused or cancelled locally before dispatch, so it changed nothing.',
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
    tone: 'warning',
    text: 'The recorded resources were provisioned and observed, but AWS health is not verified. They remain, and keep incurring charges, until they are removed.',
  },
  healthy: {
    label: 'AWS provisioning and health verified',
    tone: 'success',
    text: 'The recorded resources were provisioned and observed, and AWS reported the instance running with passing system, instance, and attached-EBS status. This is point-in-time evidence, not SSH access, guest compatibility, or readiness. The resources remain until they are removed.',
  },
  removing: { label: 'Partly removed', tone: 'warning', text: 'Removal is partly verified; recorded resources remain.' },
  removed: { label: 'Removed', tone: 'success', text: 'All recorded resources were removed and observed absent.' },
  retained: {
    label: 'Retained storage',
    tone: 'warning',
    text: 'Removal was verified. Resources retained by design remain, are not removed by Qiln, and continue to incur charges until they are deleted outside Qiln.',
  },
  'handed-off': {
    label: 'Volume handed off',
    tone: 'neutral',
    text: 'Removal was verified. The retained data volume was handed off to a later deployment, which now answers for it. This record no longer observes that volume.',
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
  if (resource.disposition === 'handed-off') {
    return 'handed off; not observed by this record'
  }
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
    ['Deployment region', record.binding.region],
    ['Approved CIDR', record.approval.cidr],
    ['Zones', record.approval.zones.map(zone => zone.name).join(', ')],
    ['Administrator CIDR', record.approval.ingress[0].cidr],
    ['Administrator account', record.approval.host.plan.bootstrap.user],
    [
      'Administrative key',
      record.adminKey === null
        ? keyDisclosure(record)
        : `${record.adminKey.algorithm} · ${keyDisclosure(record)} · generated ${record.adminKey.generatedAt}`,
    ],
    ['SSH host key', hostKeyDisclosure(record)],
    [historical ? 'VPC (historical)' : 'VPC', resourceId(record, 'create-vpc') ?? 'no identity retained'],
    ['Instance', resourceId(record, 'run-instances') ?? 'no identity retained'],
    ['Launch attempts', launchDisclosure(record)],
    ['Data volume', volumeDisclosure(record)],
    ['AWS health', healthDisclosure(record)],
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
  if (record.adminKey !== null) {
    reporter.info(
      'Removal never deletes the local key files, and deleting the AWS key pair is not guest SSH revocation.',
    )
  }
  reporter.notices([
    ...(unresolved
      ? [
          'Resources or unresolved effects may remain. No replay, adoption, deletion, rollback, or automatic recovery was attempted.',
        ]
      : []),
    ...(retained(record).length > 0
      ? [
          'Retained resources are never deleted by Qiln. They keep incurring charges for as long as they exist, including after the instance is terminated, until they are deleted outside Qiln.',
        ]
      : []),
  ])
  reportResources(reporter, record)
  if (record.removals.length > 0) {
    reporter.section('Removal outcome')
    reporter.facts(removalOutcome(record).map((row): DiagnosticFact => [row.label, `${row.state} · ${row.detail}`]))
  }
}

/**
 * Retained preparation evidence only. Absence is not a statement about the host
 * or its data volume.
 */
export function reportZfs(reporter: Reporter, preparation: ZfsRecord | null): void {
  reporter.section('ZFS preparation')
  if (preparation === null) {
    reporter.info('No ZFS preparation evidence is retained. This does not establish the state of the host or its data volume.')
    return
  }
  reporter.facts([
    ...zfsFacts(preparation),
    [
      'Storage preparation',
      prepared(preparation)
        ? 'pool verified and scrub timer verified when last recorded; not freshly observed'
        : 'not complete',
    ],
    ['Recorded steps', String(preparation.steps.length)],
  ])
  if (unsettled(preparation).length > 0) {
    reporter.space()
    reporter.notice(
      'A preparation step has no verified outcome. Interrupted remote work may already have completed, and nothing was replayed, resumed, or rolled back.',
    )
  }
}

export function reportZfsUnreadable(reporter: Reporter): void {
  reporter.section('ZFS preparation')
  reporter.notice(
    'The ZFS preparation evidence is unreadable or incompatible, so conflicting work is refused. It was not repaired, migrated, or discarded.',
  )
}

/**
 * Retained Incus preparation evidence only. Absence is not a statement about
 * the host or the Incus daemon.
 */
export function reportIncus(reporter: Reporter, preparation: IncusRecord | null): void {
  reporter.section('Incus preparation')
  if (preparation === null) {
    reporter.info('No Incus preparation evidence is retained. This does not establish the state of the host or its Incus daemon.')
    return
  }
  reporter.facts([
    ...incusFacts(preparation),
    [
      'Baseline preparation',
      retainedPreseed(preparation) !== null && !storageReleased(preparation)
        ? 'initialization verified when last recorded; not freshly observed'
        : 'not recorded as complete',
    ],
    ['Recorded steps', String(preparation.steps.length)],
  ])
  if (incusUnsettled(preparation).length > 0) {
    reporter.space()
    reporter.notice(
      'An Incus preparation step has no verified outcome. Interrupted remote work may already have completed, and nothing was replayed, resumed, or rolled back.',
    )
  }
}

export function reportIncusUnreadable(reporter: Reporter): void {
  reporter.section('Incus preparation')
  reporter.notice(
    'The Incus preparation evidence is unreadable or incompatible, so conflicting work is refused. It was not repaired, migrated, or discarded.',
  )
}
