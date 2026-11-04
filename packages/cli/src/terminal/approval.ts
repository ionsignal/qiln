import type { DiagnosticFact } from '../diagnostic/error'
import type { Prompts } from './prompts'
import type { Reporter, TableCell } from './reporter'

export interface ApprovalStep {
  label: string
  detail?: string | undefined
}

/**
 * What one approval screen says. The steps come from the plan that the approval
 * authorizes, so the screen never claims more than the approval covers. `stays`
 * names what is left alone, `lasting` what outlives the step, and
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

/**
 * The fresh observation that the plan was derived from.
 */
export interface Observed {
  label: string
  detail: string
}

export function stepsOf<Action extends string>(
  actions: readonly Action[],
  steps: Readonly<Record<Action, { label: string }>>,
  details: Partial<Record<Action, string>> = {},
): ApprovalStep[] {
  return actions.map(action => ({ label: steps[action].label, detail: details[action] }))
}

export function reportApproval(reporter: Reporter, screen: ApprovalScreen, observed?: Observed): void {
  reporter.section(screen.title)
  if (observed !== undefined) {
    reporter.row('verified', observed.label, observed.detail)
  }
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
  reporter.facts(rows.flatMap(([label, value]): DiagnosticFact[] => (value === undefined ? [] : [[label, value]])))
}

/**
 * Waits for the default-no approval, then opens the section that the applied
 * steps report under.
 */
export async function approve(prompts: Prompts, reporter: Reporter, label: string): Promise<void> {
  await prompts.approve(label)
  reporter.section('Applying')
}
