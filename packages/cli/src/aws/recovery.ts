import { catalog } from '../diagnostic/catalog'
import { InstallerError, isInstallerErrorCode, type DiagnosticFact, type InstallerErrorCode, type InstallerErrorOptions } from '../diagnostic/error'
import { isRecord } from './guards'

export type Outcome = boolean | 'not-required'

export interface RecoveryStep {
  label: string
  outcome: Outcome
  done: string
  pending: string
}

interface RecoveryOptions {
  failure: InstallerError
  code: InstallerErrorCode
  retry: string
  keepFailureRetry: boolean
  terminationConfirmed: boolean
  before?: readonly DiagnosticFact[]
  steps: readonly RecoveryStep[]
  after?: readonly DiagnosticFact[]
}

export interface RecoveryOutcomes {
  termination: boolean
  cleanup: boolean
  journal: boolean
}

export interface ToolRecoveryOutcomes {
  termination: boolean
  cleanup: Outcome
  persistence: Outcome
  lock: Outcome
}

export interface DeploymentRecoveryOutcomes {
  termination: boolean
  persistence: boolean
}

export function originalCode(error: InstallerError): InstallerErrorCode {
  if (isRecord(error) && isInstallerErrorCode(error.failureCode)) {
    return error.failureCode
  }
  return error.code
}

export function terminationConfirmed(error: unknown): boolean {
  return !(isRecord(error) && 'terminationConfirmed' in error && error.terminationConfirmed === false)
}

function stepFact(step: RecoveryStep): DiagnosticFact {
  return [step.label, step.outcome === 'not-required' ? 'not required' : step.outcome ? step.done : step.pending]
}

function describe(options: RecoveryOptions): InstallerErrorOptions {
  const { failure } = options
  const complete = options.steps.every(step => step.outcome !== false)
  const original = originalCode(failure)
  const facts: DiagnosticFact[] = []
  if (!complete) {
    facts.push(['Original failure', `${original}: ${catalog[original].title}`])
  }
  facts.push(...failure.facts, ...(options.before ?? []), ...options.steps.map(stepFact), ...(options.after ?? []))
  return {
    code: complete ? failure.code : options.code,
    facts,
    retry: complete || options.keepFailureRetry ? (failure.retry ?? options.retry) : options.retry,
  }
}

/**
 * One report for every flow whose failure leaves outstanding work. Recovery is
 * complete only when no step is unconfirmed; builders below supply each flow's
 * labels, facts, and retry text.
 */
export class RecoveryError extends InstallerError {
  public readonly failureCode: InstallerErrorCode
  public readonly terminationConfirmed: boolean

  constructor(options: RecoveryOptions) {
    super(describe(options))
    this.failureCode = originalCode(options.failure)
    this.terminationConfirmed = options.terminationConfirmed
  }
}

function confirmation(label: string, outcome: Outcome): RecoveryStep {
  return { label, outcome, done: 'confirmed', pending: 'not confirmed' }
}

function completion(label: string, outcome: Outcome): RecoveryStep {
  return { label, outcome, done: 'completed', pending: 'not confirmed' }
}

function retainedLock(terminated: boolean): DiagnosticFact[] {
  return terminated
    ? []
    : [['Connection lock', 'retained; potentially active authentication inputs were not removed']]
}

export function authRecovery(failure: InstallerError, outcomes: RecoveryOutcomes, retry: string): InstallerError {
  return new RecoveryError({
    failure,
    code: 'AWS_RECOVERY_REQUIRED',
    retry,
    keepFailureRetry: false,
    terminationConfirmed: outcomes.termination,
    steps: [
      confirmation('Authentication termination', outcomes.termination),
      completion('Authentication cleanup', outcomes.cleanup),
      completion('Binding inspection', outcomes.journal),
    ],
    after: retainedLock(outcomes.termination),
  })
}

export function lockRecovery(failure: InstallerError): InstallerError {
  return new RecoveryError({
    failure,
    code: 'AWS_RECOVERY_REQUIRED',
    retry: 'qiln aws status',
    keepFailureRetry: true,
    terminationConfirmed: terminationConfirmed(failure),
    steps: [
      {
        label: 'Connection lock',
        outcome: false,
        done: 'released',
        pending: 'release or directory synchronization not confirmed',
      },
    ],
  })
}

export function iamRecovery(
  failure: InstallerError,
  outcomes: RecoveryOutcomes,
  facts: readonly DiagnosticFact[],
  operatorPreserved: boolean,
): InstallerError {
  return new RecoveryError({
    failure,
    code: 'AWS_PERMISSION_RECOVERY_REQUIRED',
    retry: 'qiln aws --help',
    keepFailureRetry: false,
    terminationConfirmed: outcomes.termination,
    before: facts,
    steps: [
      confirmation('Root authentication termination', outcomes.termination),
      completion('Root authentication cleanup', outcomes.cleanup),
      confirmation('Pending evidence persistence', outcomes.journal),
    ],
    after: [
      ...(operatorPreserved
        ? ([['Saved operator login', 'Retained; permission maintenance does not remove ordinary authentication.']] as const)
        : []),
      ...retainedLock(outcomes.termination),
    ],
  })
}

export function toolRecovery(
  failure: InstallerError,
  outcomes: ToolRecoveryOutcomes,
  destination: string,
): InstallerError {
  return new RecoveryError({
    failure,
    code: 'AWS_TOOL_RECOVERY_REQUIRED',
    retry: 'qiln aws connect',
    keepFailureRetry: true,
    terminationConfirmed: outcomes.termination,
    before: [['Tool location', destination]],
    steps: [
      confirmation('Process termination', outcomes.termination),
      completion('Workspace cleanup', outcomes.cleanup),
      completion('Failure record', outcomes.persistence),
      {
        label: 'Tool lock release',
        outcome: outcomes.lock,
        done: 'completed',
        pending: 'retained or release not confirmed',
      },
    ],
  })
}

/**
 * Deployment evidence is written as the fence closes, so recovery tracks the
 * child's termination and whether that write was confirmed. The operation lock
 * is retained by the caller whenever termination is unconfirmed.
 */
export function deploymentRecovery(
  failure: InstallerError,
  outcomes: DeploymentRecoveryOutcomes,
  facts: readonly DiagnosticFact[],
  retry: string,
): InstallerError {
  return new RecoveryError({
    failure,
    code: 'AWS_DEPLOYMENT_RECOVERY_REQUIRED',
    retry,
    keepFailureRetry: true,
    terminationConfirmed: outcomes.termination,
    before: facts,
    steps: [
      confirmation('Child termination', outcomes.termination),
      confirmation('Deployment evidence persistence', outcomes.persistence),
    ],
    after: retainedLock(outcomes.termination),
  })
}
