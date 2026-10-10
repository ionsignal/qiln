import { InstallerError } from '../../diagnostic/error'
import { isSpec, reconciliationMode } from '../foundation/policy'
import { sameJson } from '../json'
import { pendingFacts } from './facts'
import type { Request } from './protocol'
import type { FoundationInspection, Mutation, MutationAction, MutationResult, Pending } from './types'

const FIXED_FIELDS = ['version', 'id', 'name', 'kind', 'region', 'creationId', 'startedAt'] as const
const FIXED_MUTATION_FIELDS = ['id', 'action', 'approvedAt', 'before'] as const

function invalid(): never {
  throw new InstallerError({
    code: 'AWS_PERMISSION_STATE_INVALID',
  })
}

/**
 * The verified outstanding mutation is replaced by the next intent. No phase
 * history or accumulated mutation ledger is retained.
 */
export function next(record: Pending): MutationAction | null {
  const approval = record.approval
  if (!approval || record.failureCode !== null || record.verified !== null) {
    return null
  }
  const mutation = record.mutation
  if (mutation !== null && mutation.verifiedAt === null) {
    throw new InstallerError({
      code: 'AWS_PERMISSION_RECORDED',
      facts: pendingFacts(record),
    })
  }
  if (record.kind === 'onboard') {
    switch (mutation?.action) {
      case undefined:
        return 'create-user'
      case 'create-user':
        return 'attach-signin'
      case 'attach-signin':
        return 'grant-self'
      case 'grant-self':
        return 'create-foundation'
      case 'create-foundation':
        return 'attach-foundation'
      case 'attach-foundation':
        return 'password'
      case 'password':
        return null
      default:
        return invalid()
    }
  }
  if (mutation !== null) {
    switch (mutation.action) {
      case 'create-foundation':
        return 'attach-foundation'
      case 'attach-foundation':
      case 'replace-foundation':
        return null
      default:
        return invalid()
    }
  }
  const before = approval.inspection.before
  if (!before) {
    return invalid()
  }
  switch (reconciliationMode(before.prior, approval.permission)) {
    case 'enroll':
      return 'create-foundation'
    case 'replace':
      return 'replace-foundation'
    case 'none':
      return null
    default:
      return invalid()
  }
}

export function before(record: Pending, action: MutationAction): FoundationInspection | null {
  const approval = record.approval
  if (!approval) {
    return invalid()
  }
  if (!['create-foundation', 'attach-foundation', 'replace-foundation'].includes(action)) {
    return null
  }
  const inspected = approval.inspection.before
  const baseline: FoundationInspection =
    record.kind === 'onboard'
      ? {
          signIn: approval.inspection.signIn,
          login: null,
          prior: {
            policy: null,
            versions: [],
          },
        }
      : inspected ?? invalid()
  if (action === 'attach-foundation') {
    const policy = record.foundation
    if (!policy) {
      return invalid()
    }
    return {
      ...baseline,
      prior: {
        policy,
        versions: [policy.versionId],
      },
    }
  }
  return baseline
}

function requireMutation(record: Pending): void {
  const mutation = record.mutation
  const approval = record.approval
  if (!mutation || !approval || !sameJson(mutation.before, before(record, mutation.action))) {
    return invalid()
  }
  switch (mutation.action) {
    case 'create-user':
      if (record.kind !== 'onboard' || record.operator !== null || record.foundation !== null) {
        return invalid()
      }
      break
    case 'attach-signin':
    case 'grant-self':
      if (record.kind !== 'onboard' || !record.operator || record.foundation !== null || record.password !== null) {
        return invalid()
      }
      break
    case 'create-foundation':
      if (!record.operator || record.foundation !== null || mutation.before?.prior.policy !== null) {
        return invalid()
      }
      break
    case 'attach-foundation':
      if (
        !record.operator ||
        !record.foundation ||
        !sameJson(mutation.before?.prior.policy, record.foundation) ||
        record.foundation.document !== approval.permission.document ||
        record.foundation.sha256 !== approval.permission.sha256
      ) {
        return invalid()
      }
      break
    case 'replace-foundation':
      if (
        record.kind !== 'maintain' ||
        !record.operator ||
        !record.foundation ||
        !mutation.before?.prior.policy ||
        !sameJson(record.foundation, mutation.before.prior.policy) ||
        reconciliationMode(mutation.before.prior, approval.permission) !== 'replace'
      ) {
        return invalid()
      }
      break
    case 'password':
      if (record.kind !== 'onboard' || !record.operator || !record.foundation || record.password !== null) {
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
    (record.kind === 'onboard' &&
      (mutation?.action !== 'password' || record.password?.delivered !== true || record.foundation === null)) ||
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
  const foundationChanged =
    current.foundation !== null &&
    (updated.foundation === null ||
      current.foundation.arn !== updated.foundation.arn ||
      current.foundation.id !== updated.foundation.id)
  if (
    (current.accountId !== null && current.accountId !== updated.accountId) ||
    (current.operator !== null && !sameJson(current.operator, updated.operator)) ||
    foundationChanged ||
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

function sameReceipt(previous: Extract<MutationResult, { kind: 'password' }>, updated: MutationResult | null): boolean {
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
  if (
    !mutation ||
    mutation.returned !== null ||
    mutation.verifiedAt !== null ||
    mutation.action !== next(current) ||
    !sameJson(mutation.before, before(current, mutation.action)) ||
    !sameJson(updated.operator, current.operator) ||
    !sameJson(updated.foundation, current.foundation) ||
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
    !sameJson(updated.foundation, approval.inspection.before?.prior.policy ?? null)
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
