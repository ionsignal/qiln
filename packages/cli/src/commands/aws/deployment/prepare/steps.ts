import { RECIPE as INCUS_RECIPE } from '../../../../host/incus/recipe'
import { RECIPE as ZFS_RECIPE } from '../../../../host/zfs/recipe'
import type { DiagnosticFact } from '../../../../diagnostic/error'
import type { IncusAction } from '../../../../host/incus/spec'
import type { StepAction } from '../../../../host/zfs/spec'
import type { Reporter, TableCell } from '../../../../terminal/reporter'

const DIGEST_LENGTH = 12

export const ZFS_LABELS: Record<StepAction, string> = {
  'install-packages': 'Install the approved ZFS packages',
  'write-arc': 'Write the ZFS ARC limit file',
  'load-module': 'Load the ZFS kernel module',
  'apply-arc': 'Apply the running ZFS ARC limit',
  'create-pool': 'Create the ZFS pool',
  'create-datasets': 'Create the state and storage ZFS datasets',
  'import-pool': 'Import the ZFS pool',
  'mount-state': 'Mount the Incus state dataset',
  'unmount-state': 'Unmount the Incus state dataset',
  'export-pool': 'Export the ZFS pool',
  'enable-scrub': 'Enable the monthly ZFS scrub timer',
}

export const INCUS_LABELS: Record<IncusAction, string> = {
  close: 'Mask the Incus units so no package can start them',
  guard: 'Install the storage-identity startup guard',
  'add-repository': 'Add the Zabbly signing key and APT source',
  'refresh-lists': 'Refresh APT package lists',
  'install-packages': 'Install the approved Incus packages',
  open: 'Unmask and start the Incus daemon units',
  initialize: 'Initialize Incus from the approved preseed',
  'grant-access': 'Add the administrator account to the Incus administration group',
  'stop-workloads': 'Set the Incus instances not to autostart and stop them gracefully',
  release: 'Mask the Incus units, then stop Incus and release its sockets',
}

export interface ApprovalStep {
  label: string
  detail?: string | undefined
}

/**
 * What one approval screen says. The steps come from `actionsOf(plan)`, so the
 * screen never claims more than the approval authorizes. `stays` names what is
 * left alone, `lasting` the consequences that outlive the step, and
 * `notEstablished` what the step does not prove.
 */
export interface ApprovalScreen {
  title: string
  steps: readonly ApprovalStep[]
  covers?: string | undefined
  stays?: string | undefined
  lasting?: string | undefined
  notEstablished?: string | undefined
}

export function stepsOf<Action extends string>(
  actions: readonly Action[],
  labels: Readonly<Record<Action, string>>,
  details: Partial<Record<Action, string>> = {},
): ApprovalStep[] {
  return actions.map(action => ({ label: labels[action], detail: details[action] }))
}

export function reportApproval(reporter: Reporter, observed: string, screen: ApprovalScreen): void {
  reporter.section(screen.title)
  reporter.row('verified', 'Observed host', observed)
  reporter.table(
    ['Step', 'Change'],
    screen.steps.map((step, index): TableCell[] => [
      String(index + 1),
      step.detail === undefined ? step.label : `${step.label} · ${step.detail}`,
    ]),
  )
  const rows: readonly (readonly [string, string | undefined])[] = [
    ['Covers', screen.covers],
    ['Stays', screen.stays],
    ['Lasting', screen.lasting],
    ['Not established', screen.notEstablished],
  ]
  const facts = rows.flatMap(([label, value]): DiagnosticFact[] => (value === undefined ? [] : [[label, value]]))
  if (facts.length > 0) {
    reporter.space()
    reporter.facts(facts)
  }
}

/**
 * Printed once per run instead of once per plan.
 */
export function reportRun(reporter: Reporter): void {
  reporter.info(
    'Each approved step is fenced and recorded as evidence. Qiln never undoes a step, and a failed or interrupted step is not replayed or resumed; interrupted work may already have completed.',
  )
  reporter.info(
    `Recipes · ZFS revision ${ZFS_RECIPE.revision} (${ZFS_RECIPE.digest.slice(0, DIGEST_LENGTH)}) · Incus revision ${INCUS_RECIPE.revision} (${INCUS_RECIPE.digest.slice(0, DIGEST_LENGTH)})`,
  )
}
