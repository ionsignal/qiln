import { InstallerError } from '../../diagnostic/error'
import { sameJson } from '../../json'
import { POLICY_KEYS, policyMap, type PolicyKey, type PolicyMap } from '../permission/keys'
import { emptySnapshot, type PolicyIdentity, type PolicySnapshot } from '../permission/policy'
import { isSpec, reconciliation } from '../permission/spec'
import { pendingFacts } from './facts'
import type { Request } from './protocol'
import type { Mutation, MutationAction, PermissionInspection, Pending } from './types'

const FIXED_FIELDS = ['version', 'id', 'name', 'kind', 'region', 'creationId', 'startedAt'] as const
const FIXED_MUTATION_FIELDS = ['id', 'action', 'key', 'approvedAt'] as const

export interface Step {
  action: MutationAction
  key: PolicyKey | null
}

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}

function baseline(record: Pending): PolicyMap<PolicySnapshot> {
  return record.approval?.inspection.before?.policies ?? policyMap(emptySnapshot)
}

/**
 * The approved sequence, derived from the approval alone. One mutating call
 * runs per step, and policies are reconciled in key order.
 */
export function plan(record: Pending): Step[] {
  const approval = record.approval
  if (!approval) {
    return invalid()
  }
  const modes = reconciliation(approval.inspection.before?.policies ?? null, approval.permission)
  const policySteps = POLICY_KEYS.flatMap((key): Step[] => {
    switch (modes[key]) {
      case 'enroll':
        return [
          { action: 'create-policy', key },
          { action: 'attach-policy', key },
        ]
      case 'replace':
        return [{ action: 'replace-policy', key }]
      case 'none':
        return []
    }
  })
  if (record.kind === 'maintain') {
    return policySteps
  }
  return [
    { action: 'create-user', key: null },
    { action: 'attach-signin', key: null },
    { action: 'grant-self', key: null },
    ...policySteps,
    { action: 'password', key: null },
  ]
}

/** Index of the outstanding mutation within the plan. */
export function position(record: Pending): number {
  const mutation = record.mutation
  if (!mutation) {
    return invalid()
  }
  const index = plan(record).findIndex(step => step.action === mutation.action && step.key === mutation.key)
  if (index < 0) {
    return invalid()
  }
  return index
}

function apply(snapshot: PolicySnapshot, action: MutationAction, policy: PolicyIdentity): PolicySnapshot {
  switch (action) {
    case 'create-policy':
      return { policy, versions: [policy.versionId], attached: false }
    case 'attach-policy':
      return { ...snapshot, attached: true }
    case 'replace-policy':
      return { policy, versions: [...snapshot.versions, policy.versionId].sort(), attached: true }
    default:
      return invalid()
  }
}

/**
 * The state expected once the first `completed` plan steps are verified: the
 * approved baseline with each policy step folded in. Retained identities supply
 * the policy each step created or replaced.
 */
export function expectation(record: Pending, completed: number): PermissionInspection {
  const approval = record.approval
  if (!approval) {
    return invalid()
  }
  const policies = structuredClone(baseline(record))
  for (const { action, key } of plan(record).slice(0, completed)) {
    if (key !== null) {
      policies[key] = apply(policies[key], action, record.policies[key] ?? invalid())
    }
  }
  return {
    signIn: approval.inspection.signIn,
    login: approval.inspection.before?.login ?? null,
    policies,
  }
}

/**
 * The verified outstanding mutation is replaced by the next intent. No phase
 * history or accumulated mutation ledger is retained.
 */
export function next(record: Pending): Step | null {
  if (!record.approval || record.failureCode !== null || record.verified !== null) {
    return null
  }
  const mutation = record.mutation
  if (mutation !== null && mutation.verifiedAt === null) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_RECORDED',
      facts: pendingFacts(record),
    })
  }
  return plan(record).at(mutation === null ? 0 : position(record) + 1) ?? null
}

function requireMutation(record: Pending): void {
  const mutation = record.mutation
  const approval = record.approval
  if (!mutation || !approval) {
    return invalid()
  }
  // Only a step of the approved plan may execute.
  position(record)
  const key = mutation.key
  switch (mutation.action) {
    case 'create-user':
      if (record.kind !== 'onboard' || record.operator !== null || POLICY_KEYS.some(name => record.policies[name] !== null)) {
        return invalid()
      }
      break
    case 'attach-signin':
    case 'grant-self':
      if (
        record.kind !== 'onboard' ||
        !record.operator ||
        record.password !== null ||
        POLICY_KEYS.some(name => record.policies[name] !== null)
      ) {
        return invalid()
      }
      break
    case 'create-policy':
      if (!record.operator || key === null || record.policies[key] !== null) {
        return invalid()
      }
      break
    case 'attach-policy':
      if (
        !record.operator ||
        key === null ||
        record.policies[key]?.sha256 !== approval.permission.policies[key].sha256
      ) {
        return invalid()
      }
      break
    case 'replace-policy':
      if (
        record.kind !== 'maintain' ||
        !record.operator ||
        key === null ||
        !sameJson(record.policies[key], baseline(record)[key].policy)
      ) {
        return invalid()
      }
      break
    case 'password':
      if (record.kind !== 'onboard' || !record.operator || record.password !== null) {
        return invalid()
      }
      break
  }
}

/**
 * Child-side authority check. Execution is reloaded from durable evidence, not
 * from the request payload, which only names the operation and region.
 */
export function authorize(record: Pending, request: Request): void {
  if (
    request.operationId !== record.id ||
    request.region !== record.region ||
    record.failureCode !== null ||
    record.termination !== 'unconfirmed' ||
    record.cleanup !== 'pending'
  ) {
    return invalid()
  }
  if (request.kind === 'inspect') {
    if (record.approval !== null || record.mutation !== null) {
      return invalid()
    }
    return
  }
  const approval = record.approval
  if (
    !approval ||
    record.accountId === null ||
    !isSpec(approval.permission, record.accountId, record.name) ||
    record.verified !== null
  ) {
    return invalid()
  }
  const mutation = record.mutation
  if (request.kind === 'mutate') {
    if (!mutation || mutation.returned !== null || mutation.verifiedAt !== null) {
      return invalid()
    }
    requireMutation(record)
    return
  }
  if (request.kind === 'verify-mutation') {
    if (!mutation?.returned || mutation.verifiedAt !== null) {
      return invalid()
    }
    return
  }
  if (
    (mutation !== null && mutation.verifiedAt === null) ||
    next(record) !== null ||
    !record.operator ||
    POLICY_KEYS.some(key => record.policies[key] === null) ||
    (record.kind === 'onboard' && (mutation?.action !== 'password' || record.password?.delivered !== true)) ||
    (request.kind === 'readiness' && record.kind !== 'onboard')
  ) {
    return invalid()
  }
}

function requireFixedFields(current: Pending, updated: Pending): void {
  for (const key of FIXED_FIELDS) {
    if (!sameJson(current[key], updated[key])) {
      return invalid()
    }
  }
}

/**
 * Identities, approval, and terminal outcomes may be added once but never
 * rewritten or dropped.
 */
function requireRetainedEvidence(current: Pending, updated: Pending): void {
  const policyChanged = POLICY_KEYS.some(key => {
    const before = current.policies[key]
    const after = updated.policies[key]
    return before !== null && (after === null || before.arn !== after.arn || before.id !== after.id)
  })
  if (
    (current.accountId !== null && current.accountId !== updated.accountId) ||
    (current.operator !== null && !sameJson(current.operator, updated.operator)) ||
    policyChanged ||
    (current.approval !== null && !sameJson(current.approval, updated.approval)) ||
    (current.verified !== null && !sameJson(current.verified, updated.verified)) ||
    (current.failureCode !== null && current.failureCode !== updated.failureCode) ||
    (current.cleanup === 'completed' && updated.cleanup !== 'completed')
  ) {
    return invalid()
  }
}

function requireRetainedPassword(current: Pending, updated: Pending): void {
  if (
    current.password !== null &&
    (updated.password === null ||
      current.password.createdAt !== updated.password.createdAt ||
      (current.password.delivered && !updated.password.delivered))
  ) {
    return invalid()
  }
}

function sameReceipt(
  previous: Extract<NonNullable<Mutation['returned']>, { kind: 'password' }>,
  updated: Mutation['returned'],
): boolean {
  return (
    updated?.kind === 'password' &&
    previous.receipt.createdAt === updated.receipt.createdAt &&
    (!previous.receipt.delivered || updated.receipt.delivered)
  )
}

function requireSameMutation(previous: Mutation, updated: Mutation): void {
  for (const key of FIXED_MUTATION_FIELDS) {
    if (!sameJson(previous[key], updated[key])) {
      return invalid()
    }
  }
  const returnedChanged =
    previous.returned !== null &&
    (previous.returned.kind === 'password'
      ? !sameReceipt(previous.returned, updated.returned)
      : !sameJson(previous.returned, updated.returned))
  if (returnedChanged || (previous.verifiedAt !== null && !sameJson(previous, updated))) {
    return invalid()
  }
}

/**
 * A new mutation may begin only as the next intent, with no returned result,
 * and with every retained binding unchanged.
 */
function requireNewMutation(current: Pending, updated: Pending): void {
  const mutation = updated.mutation
  const step = next(current)
  if (
    !mutation ||
    mutation.returned !== null ||
    mutation.verifiedAt !== null ||
    step === null ||
    mutation.action !== step.action ||
    mutation.key !== step.key ||
    !sameJson(updated.operator, current.operator) ||
    !sameJson(updated.policies, current.policies) ||
    !sameJson(updated.password, current.password) ||
    updated.termination !== 'unconfirmed'
  ) {
    return invalid()
  }
}

function requireMutationProgress(current: Pending, updated: Pending): void {
  const previous = current.mutation
  const latest = updated.mutation
  if (previous?.id === latest?.id) {
    if (previous && latest) {
      requireSameMutation(previous, latest)
    }
    return
  }
  requireNewMutation(current, updated)
}

function requireFirstApproval(current: Pending, updated: Pending): void {
  const approval = updated.approval
  if (current.approval !== null || approval === null) {
    return
  }
  if (
    current.mutation !== null ||
    updated.mutation !== null ||
    !isSpec(approval.permission, approval.inspection.root.identity.accountId, updated.name) ||
    !sameJson(
      updated.policies,
      policyMap(key => approval.inspection.before?.policies[key].policy ?? null),
    )
  ) {
    return invalid()
  }
}

/**
 * The journal's write rule: one record may replace another only through a
 * permitted step. Each rule below states one invariant.
 */
export function requireTransition(current: Pending, updated: Pending): void {
  requireFixedFields(current, updated)
  requireRetainedEvidence(current, updated)
  requireRetainedPassword(current, updated)
  requireMutationProgress(current, updated)
  requireFirstApproval(current, updated)
}
