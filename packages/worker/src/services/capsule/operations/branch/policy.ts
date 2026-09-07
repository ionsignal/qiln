import {
  CapsuleBranchStartReceiptSchema,
  CapsuleBranchStopReceiptSchema,
  CapsuleOperationStatus,
  CapsuleOperationType,
  type CapsuleBranchStatus,
} from '@qiln/core/server'
import type { ZodType } from 'zod'
import { IncusError } from '../../../../errors'
import { toCapsuleOperationTransition } from '../shared'
import type {
  BranchCapsuleRow,
  BranchExtensionRow,
  BranchFailureDecision,
  BranchFailureInput,
  BranchOperationRow,
  BranchOperationType,
  BranchReceipt,
  BranchRow,
  BranchState,
  LockedBranchOperation,
  ValidatedBranchOperation,
} from './types'

interface BranchDefinition<TOperation extends BranchOperationType> {
  type: TOperation
  action: 'start' | 'stop'
  initial: 'offline' | 'online'
  accepted: 'starting' | 'stopping'
  successful: 'online' | 'offline'
  ownedStatuses: readonly CapsuleBranchStatus[]
}

/**
 * These definitions describe fixed transitions, not configurable workflows.
 * Provider ordering and SSH/preview coordination stay in the two executors.
 */
export const definitions: {
  [TOperation in BranchOperationType]: BranchDefinition<TOperation>
} = {
  branch_start: {
    type: CapsuleOperationType.BRANCH_START,
    action: 'start',
    initial: 'offline',
    accepted: 'starting',
    successful: 'online',
    ownedStatuses: ['starting', 'online'],
  },
  branch_stop: {
    type: CapsuleOperationType.BRANCH_STOP,
    action: 'stop',
    initial: 'online',
    accepted: 'stopping',
    successful: 'offline',
    ownedStatuses: ['stopping'],
  },
}

const receiptSchemas: {
  [TOperation in BranchOperationType]: ZodType<BranchReceipt<TOperation>>
} = {
  branch_start: CapsuleBranchStartReceiptSchema,
  branch_stop: CapsuleBranchStopReceiptSchema,
}

export function isNonterminal(status: BranchOperationRow['status']): boolean {
  return status === CapsuleOperationStatus.ACCEPTED || status === CapsuleOperationStatus.RUNNING
}

export function assertActive(capsule: BranchCapsuleRow): void {
  if (capsule.lifecycleStatus === 'active' && capsule.archivedAt === null && capsule.destroyedAt === null) {
    return
  }
  throw new IncusError('Branch runtime operations require an active, unarchived capsule.', 'CONFLICT', {
    capsuleId: capsule.id,
    lifecycleStatus: capsule.lifecycleStatus,
    archived: capsule.archivedAt !== null,
  })
}

export function inspectIdentity(scope: LockedBranchOperation, type: BranchOperationType): string[] {
  const { capsule, operation, extension, branch } = scope
  const reasons: string[] = []
  if (operation.type !== type) {
    reasons.push('operation_type_mismatch')
  }
  if (operation.capsuleId !== capsule.id || operation.ownerId !== capsule.ownerId) {
    reasons.push('operation_capsule_identity_mismatch')
  }
  if (!extension) {
    reasons.push('branch_runtime_extension_missing')
  } else if (extension.operationId !== operation.id) {
    reasons.push('extension_operation_identity_mismatch')
  }
  if (!branch) {
    reasons.push('branch_target_missing')
  } else {
    if (branch.ownerId !== operation.ownerId || branch.capsuleId !== operation.capsuleId) {
      reasons.push('branch_ownership_mismatch')
    }
    if (extension && (extension.branchId !== branch.id || extension.branchName !== branch.name)) {
      reasons.push('extension_branch_identity_mismatch')
    }
  }
  return reasons
}

export function identity(scope: LockedBranchOperation, type: BranchOperationType): ValidatedBranchOperation {
  const reasons = inspectIdentity(scope, type)
  if (reasons.length > 0 || scope.extension === null || scope.branch === null) {
    throw new IncusError('Branch runtime operation does not match its immutable target.', 'CONFLICT', {
      operationId: scope.operation.id,
      operationType: type,
      capsuleId: scope.operation.capsuleId,
      branchId: scope.extension?.branchId ?? null,
      reasons,
    })
  }
  return {
    ...scope,
    extension: scope.extension,
    branch: scope.branch,
  }
}

/**
 * Basic ledger consistency is checked independently from the requested
 * transition. A nonterminal status cannot conceal terminal evidence.
 */
export function inspectOperation(operation: BranchOperationRow): string[] {
  const reasons: string[] = []
  if (
    operation.completedAt !== null ||
    operation.failedAt !== null ||
    operation.failureCode !== null ||
    operation.failureMessage !== null ||
    operation.failureDetails !== null
  ) {
    reasons.push('nonterminal_operation_contains_terminal_evidence')
  }
  if (operation.status === CapsuleOperationStatus.ACCEPTED && operation.executionStartedAt !== null) {
    reasons.push('accepted_operation_contains_execution_timestamp')
  }
  if (operation.status === CapsuleOperationStatus.RUNNING && operation.executionStartedAt === null) {
    reasons.push('running_operation_missing_execution_timestamp')
  }
  if (
    operation.providerMutationStartedAt !== null &&
    (operation.status !== CapsuleOperationStatus.RUNNING || operation.executionStartedAt === null)
  ) {
    reasons.push('provider_intent_without_running_execution')
  }
  return reasons
}

/**
 * Restoration is limited to the accepted runtime state and consistent evidence.
 * It never restores grants, tickets, relays, or preview availability.
 *
 * An abandoned provider intent is always uncertain. Only a live executor may
 * supply the positively observed previous runtime state.
 */
export function classify(
  scope: LockedBranchOperation,
  type: BranchOperationType,
  input: BranchFailureInput,
  origin: 'live' | 'abandoned',
): BranchFailureDecision {
  const definition = definitions[type]
  const identityReasons = inspectIdentity(scope, type)
  const identityValid = identityReasons.length === 0
  const reasons = [...identityReasons, ...inspectOperation(scope.operation)]
  const providerIntentRecorded = scope.operation.providerMutationStartedAt !== null
  if (
    scope.capsule.lifecycleStatus !== 'active' ||
    scope.capsule.archivedAt !== null ||
    scope.capsule.destroyedAt !== null
  ) {
    reasons.push('capsule_no_longer_active')
  }
  if (scope.branch && scope.branch.status !== definition.accepted) {
    reasons.push('branch_no_longer_in_accepted_state')
  }
  if (
    type === CapsuleOperationType.BRANCH_START &&
    scope.branch?.status === 'starting' &&
    scope.branch.runtimeIp !== null
  ) {
    reasons.push('starting_branch_retains_runtime_ip')
  }
  if (origin === 'abandoned') {
    if (providerIntentRecorded) {
      reasons.push('abandoned_provider_intent')
    }
  } else {
    if (input.disposition === 'cleanup_required') {
      reasons.push('executor_reported_uncertainty')
    } else if (input.disposition === 'previous_confirmed') {
      if (!providerIntentRecorded) {
        reasons.push('runtime_observation_without_provider_intent')
      }
      if (type === CapsuleOperationType.BRANCH_STOP && input.runtimeIp === undefined) {
        reasons.push('confirmed_stop_failure_missing_runtime_observation')
      }
    } else if (providerIntentRecorded) {
      reasons.push('provider_intent_without_confirmed_previous_state')
    }
  }
  const cleanupRequired = reasons.length > 0
  const canUpdateBranch =
    identityValid && scope.branch !== null && definition.ownedStatuses.includes(scope.branch.status)
  return {
    cleanupRequired,
    identityValid,
    branchStatus: canUpdateBranch ? (cleanupRequired ? 'cleanup_required' : definition.initial) : null,
    reasons,
  }
}

export function state(branch: Pick<BranchRow, 'id' | 'capsuleId' | 'name' | 'status'>): BranchState {
  return {
    id: branch.id,
    capsuleId: branch.capsuleId,
    name: branch.name,
    status: branch.status,
  }
}

export function transition(operation: Pick<BranchOperationRow, 'id' | 'ownerId' | 'capsuleId' | 'type' | 'status'>) {
  return toCapsuleOperationTransition({
    ownerId: operation.ownerId,
    operationId: operation.id,
    operationType: operation.type,
    operationStatus: operation.status,
    capsuleId: operation.capsuleId,
  })
}

/**
 * The schema map preserves the concrete receipt type without asserting that a
 * union receipt is a start or stop receipt. Target names come from immutable
 * acceptance-time input rather than a reconstructed request.
 */
export function receipt<TOperation extends BranchOperationType>(
  type: TOperation,
  operation: BranchOperationRow,
  extension: BranchExtensionRow,
  replayed: boolean,
): BranchReceipt<TOperation> {
  if (operation.type !== type || extension.operationId !== operation.id) {
    throw new IncusError('Branch receipt does not match its durable operation identity.', 'CONFLICT', {
      operationId: operation.id,
      operationType: operation.type,
      expectedOperationType: type,
    })
  }
  return receiptSchemas[type].parse({
    operationId: operation.id,
    operationType: type,
    operationStatus: operation.status,
    capsuleId: operation.capsuleId,
    branchId: extension.branchId,
    branchName: extension.branchName,
    replayed,
  })
}
