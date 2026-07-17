import { CapsuleOperationStatus, type CapsuleLifecycleStatusValue, type CapsuleOperationStatusValue } from '@qiln/core/server'
import type { DestroyCapsuleBranchLineageInspection } from './lineage'

export type DestroyNonterminalOperationStatus = typeof CapsuleOperationStatus.ACCEPTED | typeof CapsuleOperationStatus.RUNNING

export type DestroyTerminalOperationStatus = Exclude<CapsuleOperationStatusValue, DestroyNonterminalOperationStatus>

export type DestroyOperationTerminality =
  | {
      kind: 'nonterminal'
      operationStatus: DestroyNonterminalOperationStatus
    }
  | {
      kind: 'already_terminal'
      operationStatus: DestroyTerminalOperationStatus
    }

export interface DestroyFailureOperationEvidence {
  operationStatus: DestroyNonterminalOperationStatus
  branchId: string | null
  providerMutationStartedAt: Date | null
}

export interface DestroyFailureCapsuleEvidence {
  lifecycleStatus: CapsuleLifecycleStatusValue
  archivedAt: Date | null
}

export interface DestroyNonterminalFailureEvidence {
  operation: DestroyFailureOperationEvidence
  capsule: DestroyFailureCapsuleEvidence
  lineage: DestroyCapsuleBranchLineageInspection
}

export type DestroyCleanupRequiredReason =
  | {
      code: 'provider_intent_present'
      providerMutationStartedAt: Date
    }
  | {
      code: 'operation_branch_reference_present'
      branchId: string
    }
  | {
      code: 'capsule_lifecycle_mismatch'
      expectedLifecycleStatus: 'destroying'
      actualLifecycleStatus: CapsuleLifecycleStatusValue
    }
  | {
      code: 'capsule_archive_timestamp_missing'
    }
  | {
      code: 'destroying_lineage_policy_mismatch'
      expectedRequiredStatus: 'destroying'
      actualRequiredStatus: DestroyCapsuleBranchLineageInspection['requiredStatus']
    }
  | {
      code: 'destroying_branch_lineage_invalid'
      branchCount: number
      rootBranchCount: number
      requiredStatus: DestroyCapsuleBranchLineageInspection['requiredStatus']
    }

export type DestroyNonterminalFailureDecision =
  | {
      kind: 'safe_pre_provider_failure'
    }
  | {
      kind: 'cleanup_required'
      reasons: readonly DestroyCleanupRequiredReason[]
      providerOwnershipUncertain: boolean
      invariantViolation: boolean
    }

/**
 * Determines whether a destroy operation still requires failure
 * classification.
 *
 * This is kept in the destroy failure-policy boundary so persistence code does
 * not independently redefine which operation states are terminal.
 */
export function inspectDestroyOperationTerminality(operationStatus: CapsuleOperationStatusValue): DestroyOperationTerminality {
  if (isDestroyNonterminalOperationStatus(operationStatus)) {
    return {
      kind: 'nonterminal',
      operationStatus,
    }
  }
  return {
    kind: 'already_terminal',
    operationStatus,
  }
}

export function isDestroyNonterminalOperationStatus(
  operationStatus: CapsuleOperationStatusValue,
): operationStatus is DestroyNonterminalOperationStatus {
  return operationStatus === CapsuleOperationStatus.ACCEPTED || operationStatus === CapsuleOperationStatus.RUNNING
}

/**
 * Classifies a nonterminal destroy failure using only already-loaded durable
 * PostgreSQL evidence.
 *
 * Safe restoration requires all of the following:
 *
 * - no operation-wide provider-intent fence;
 * - no branch reference on the capsule-scoped operation;
 * - the capsule remains in its destroying lifecycle fence;
 * - the capsule remains archived;
 * - every branch remains in the expected destroying lineage;
 * - owner, capsule, and root-branch lineage remain valid.
 *
 * Any provider intent or contradictory durable evidence fails closed to
 * cleanup-required. This function performs no persistence, provider calls,
 * event publication, or process-local state inspection.
 */
export function decideDestroyNonterminalFailure(evidence: DestroyNonterminalFailureEvidence): DestroyNonterminalFailureDecision {
  const reasons: DestroyCleanupRequiredReason[] = []
  if (evidence.operation.providerMutationStartedAt !== null) {
    reasons.push({
      code: 'provider_intent_present',
      providerMutationStartedAt: evidence.operation.providerMutationStartedAt,
    })
  }
  if (evidence.operation.branchId !== null) {
    reasons.push({
      code: 'operation_branch_reference_present',
      branchId: evidence.operation.branchId,
    })
  }
  if (evidence.capsule.lifecycleStatus !== 'destroying') {
    reasons.push({
      code: 'capsule_lifecycle_mismatch',
      expectedLifecycleStatus: 'destroying',
      actualLifecycleStatus: evidence.capsule.lifecycleStatus,
    })
  }
  if (evidence.capsule.archivedAt === null) {
    reasons.push({
      code: 'capsule_archive_timestamp_missing',
    })
  }
  if (evidence.lineage.requiredStatus !== 'destroying') {
    reasons.push({
      code: 'destroying_lineage_policy_mismatch',
      expectedRequiredStatus: 'destroying',
      actualRequiredStatus: evidence.lineage.requiredStatus,
    })
  }
  if (!evidence.lineage.valid) {
    reasons.push({
      code: 'destroying_branch_lineage_invalid',
      branchCount: evidence.lineage.branchCount,
      rootBranchCount: evidence.lineage.rootBranchCount,
      requiredStatus: evidence.lineage.requiredStatus,
    })
  }
  if (reasons.length === 0) {
    return {
      kind: 'safe_pre_provider_failure',
    }
  }
  const providerOwnershipUncertain = evidence.operation.providerMutationStartedAt !== null
  return {
    kind: 'cleanup_required',
    reasons,
    providerOwnershipUncertain,
    // Preserve the existing diagnostic distinction: contradictory evidence
    // before provider intent is an invariant violation, while committed
    // provider intent makes provider ownership uncertain.
    invariantViolation: !providerOwnershipUncertain,
  }
}
