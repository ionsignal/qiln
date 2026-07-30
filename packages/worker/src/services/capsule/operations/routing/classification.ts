import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleOperationStatus,
  CapsuleOperationType,
  verifyCapsuleRouteEvidencePin,
  verifyCapsuleRouteTargetPin,
  type CapsuleOperationTypeValue,
  type CapsulePersistence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../errors'
import { toJsonObject } from '../../persistence/json'
import { toCapsuleOperationTransition, type CapsuleOperationTransitionOutput } from '../shared'
import type { CommittedRouteState } from '../../routing'

const NONTERMINAL_STATUSES = [CapsuleOperationStatus.ACCEPTED, CapsuleOperationStatus.RUNNING] as const
const PROVIDER_STATUSES = [
  'planned',
  'applying',
  'applied',
  'verifying',
  'verified',
  'failed',
  'cleanup_required',
] as const

export type RouteOperationType = typeof CapsuleOperationType.PROMOTE | typeof CapsuleOperationType.ROLLBACK

export interface RouteAbandonmentResult {
  operation: CapsuleOperationTransitionOutput
  route: CommittedRouteState | null
}

function actionFor(type: RouteOperationType): 'promote' | 'rollback' {
  return type === CapsuleOperationType.PROMOTE ? 'promote' : 'rollback'
}

/**
 * Classifies abandoned promote and rollback operations exclusively from locked
 * PostgreSQL evidence.
 *
 * No Caddy configuration or runtime mutation is applied or retried.
 */
export class RouteOperationAbandonmentClassifier<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(private readonly persistence: CapsulePersistence<TDatabase, TTables>) {}

  public async classify(operationId: string, expectedType: RouteOperationType): Promise<RouteAbandonmentResult | null> {
    return await this.persistence.db.transaction(async tx => {
      const tables = this.persistence.tables
      const [operation] = await tx
        .select()
        .from(tables.capsuleOperations)
        .where(eq(tables.capsuleOperations.id, operationId))
        .for('update')
        .limit(1)
      if (!operation) {
        throw new IncusError('Route operation was not found.', 'NOT_FOUND', {
          operationId,
        })
      }
      if (operation.type !== expectedType) {
        throw new IncusError('Route abandonment classifier received the wrong operation type.', 'CONFLICT', {
          operationId,
          expectedType,
          actualType: operation.type,
        })
      }
      if (!NONTERMINAL_STATUSES.includes(operation.status as (typeof NONTERMINAL_STATUSES)[number])) {
        return null
      }
      const [extension] = await tx
        .select()
        .from(tables.capsuleRouteOperations)
        .where(eq(tables.capsuleRouteOperations.operationId, operation.id))
        .for('update')
        .limit(1)
      const [alias] = extension
        ? await tx
            .select()
            .from(tables.capsuleRouteAliases)
            .where(eq(tables.capsuleRouteAliases.id, extension.aliasId))
            .for('update')
            .limit(1)
        : []
      const [revision] = extension
        ? await tx
            .select()
            .from(tables.capsuleRouteRevisions)
            .where(eq(tables.capsuleRouteRevisions.id, extension.proposedRevisionId))
            .for('update')
            .limit(1)
        : []
      const [provider] = extension
        ? await tx
            .select()
            .from(tables.capsuleRouteProviderApplications)
            .where(eq(tables.capsuleRouteProviderApplications.operationId, operation.id))
            .for('update')
            .limit(1)
        : []
      const [head] = extension
        ? await tx
            .select()
            .from(tables.capsuleRouteHeads)
            .where(eq(tables.capsuleRouteHeads.aliasId, extension.aliasId))
            .for('update')
            .limit(1)
        : []
      const [snapshot] = revision
        ? await tx
            .select({
              id: tables.capsuleSnapshots.id,
              capsuleId: tables.capsuleSnapshots.capsuleId,
            })
            .from(tables.capsuleSnapshots)
            .where(eq(tables.capsuleSnapshots.id, revision.snapshotId))
            .for('update')
            .limit(1)
        : []
      const [rollbackSource] =
        revision?.rollbackSourceRevisionId !== null && revision?.rollbackSourceRevisionId !== undefined
          ? await tx
              .select({
                id: tables.capsuleRouteRevisions.id,
                aliasId: tables.capsuleRouteRevisions.aliasId,
                status: tables.capsuleRouteRevisions.status,
                committedAt: tables.capsuleRouteRevisions.committedAt,
              })
              .from(tables.capsuleRouteRevisions)
              .where(eq(tables.capsuleRouteRevisions.id, revision.rollbackSourceRevisionId))
              .for('update')
              .limit(1)
          : []
      const reasons: string[] = []
      const expectedAction = actionFor(expectedType)
      if (operation.providerMutationStartedAt !== null) {
        reasons.push('provider_intent_present')
      }
      if (!extension) {
        reasons.push('route_operation_extension_missing')
      }
      if (!alias) {
        reasons.push('route_alias_missing')
      }
      if (!revision) {
        reasons.push('proposed_revision_missing')
      }
      if (!provider) {
        reasons.push('provider_accounting_missing')
      }
      if (extension && extension.action !== expectedAction) {
        reasons.push('extension_action_mismatch')
      }
      if (alias) {
        if (alias.ownerId !== operation.ownerId || alias.capsuleId !== operation.capsuleId) {
          reasons.push('alias_operation_identity_mismatch')
        }
        if (alias.status !== 'mutating' || alias.mutationOperationId !== operation.id) {
          reasons.push('alias_mutation_fence_mismatch')
        }
      }
      if (revision && extension) {
        if (
          revision.id !== extension.proposedRevisionId ||
          revision.aliasId !== extension.aliasId ||
          revision.operationId !== operation.id ||
          revision.action !== expectedAction ||
          revision.status !== 'proposed' ||
          revision.committedAt !== null ||
          revision.failedAt !== null
        ) {
          reasons.push('proposed_revision_identity_mismatch')
        }
        if (revision.previousRevisionId !== extension.expectedRevisionId) {
          reasons.push('revision_expected_head_mismatch')
        }
        if (revision.rollbackSourceRevisionId !== extension.rollbackSourceRevisionId) {
          reasons.push('revision_rollback_source_mismatch')
        }
      }
      if ((head?.revisionId ?? null) !== (extension?.expectedRevisionId ?? null)) {
        reasons.push('alias_head_changed')
      }
      if (provider && revision) {
        if (
          provider.revisionId !== revision.id ||
          provider.status !== 'planned' ||
          provider.configurationKey !== null ||
          provider.configurationDigest !== null ||
          provider.configuration !== null ||
          provider.applyIntentAt !== null ||
          provider.appliedAt !== null ||
          provider.verificationIntentAt !== null ||
          provider.verificationEvidence !== null ||
          provider.verifiedAt !== null ||
          provider.failureAt !== null
        ) {
          reasons.push('provider_accounting_not_pristine')
        }
      }
      if (snapshot && snapshot.capsuleId !== operation.capsuleId) {
        reasons.push('target_snapshot_capsule_mismatch')
      }
      if (revision && !snapshot) {
        reasons.push('target_snapshot_missing')
      }
      if (expectedType === CapsuleOperationType.ROLLBACK) {
        if (
          !rollbackSource ||
          !alias ||
          rollbackSource.aliasId !== alias.id ||
          rollbackSource.status !== 'committed' ||
          rollbackSource.committedAt === null
        ) {
          reasons.push('rollback_source_not_committed')
        }
      } else if (revision?.rollbackSourceRevisionId !== null || extension?.rollbackSourceRevisionId !== null) {
        reasons.push('promotion_contains_rollback_source')
      }
      if (revision) {
        try {
          const target = verifyCapsuleRouteTargetPin(revision.targetPin)
          verifyCapsuleRouteEvidencePin(revision.evidencePin)
          if (target.snapshotId !== revision.snapshotId) {
            reasons.push('target_pin_snapshot_mismatch')
          }
        } catch {
          reasons.push('route_pin_invalid')
        }
      }
      const safe = reasons.length === 0
      const error = {
        code: safe ? 'ABANDONED_ROUTE_OPERATION' : 'ABANDONED_ROUTE_OPERATION_UNCERTAIN',
        message: safe
          ? 'Route operation was abandoned before provider mutation.'
          : 'Route operation was abandoned with incomplete or uncertain durable evidence.',
      }
      const details = toJsonObject(
        {
          operationId: operation.id,
          operationType: expectedType,
          capsuleId: operation.capsuleId,
          classification: safe ? 'safe_pre_provider_route_failure' : 'route_cleanup_required',
          providerIntentCommitted: operation.providerMutationStartedAt !== null,
          reasons,
          policy: 'never_reapply_caddy_after_worker_restart',
        },
        'route abandonment failure details',
      )
      const now = new Date()
      if (safe && extension && alias && revision && provider) {
        const [failedOperation] = await tx
          .update(tables.capsuleOperations)
          .set({
            status: CapsuleOperationStatus.FAILED,
            failedAt: now,
            failureCode: error.code,
            failureMessage: error.message,
            failureDetails: details,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capsuleOperations.id, operation.id),
              eq(tables.capsuleOperations.type, expectedType),
              inArray(tables.capsuleOperations.status, NONTERMINAL_STATUSES),
            ),
          )
          .returning({
            id: tables.capsuleOperations.id,
          })
        const [failedRevision] = await tx
          .update(tables.capsuleRouteRevisions)
          .set({
            status: 'failed',
            failedAt: now,
          })
          .where(
            and(
              eq(tables.capsuleRouteRevisions.id, revision.id),
              eq(tables.capsuleRouteRevisions.operationId, operation.id),
              eq(tables.capsuleRouteRevisions.status, 'proposed'),
            ),
          )
          .returning({
            id: tables.capsuleRouteRevisions.id,
          })
        const [failedProvider] = await tx
          .update(tables.capsuleRouteProviderApplications)
          .set({
            status: 'failed',
            failureCode: error.code,
            failureMessage: error.message,
            failureDetails: details,
            failureAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capsuleRouteProviderApplications.operationId, operation.id),
              eq(tables.capsuleRouteProviderApplications.revisionId, revision.id),
              eq(tables.capsuleRouteProviderApplications.status, 'planned'),
            ),
          )
          .returning({
            operationId: tables.capsuleRouteProviderApplications.operationId,
          })
        const restoredStatus = head ? 'active' : 'inactive'
        const [restoredAlias] = await tx
          .update(tables.capsuleRouteAliases)
          .set({
            status: restoredStatus,
            mutationOperationId: null,
            lastOperationId: operation.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capsuleRouteAliases.id, alias.id),
              eq(tables.capsuleRouteAliases.status, 'mutating'),
              eq(tables.capsuleRouteAliases.mutationOperationId, operation.id),
            ),
          )
          .returning({
            id: tables.capsuleRouteAliases.id,
            capsuleId: tables.capsuleRouteAliases.capsuleId,
            name: tables.capsuleRouteAliases.name,
            status: tables.capsuleRouteAliases.status,
          })
        if (!failedOperation || !failedRevision || !failedProvider || !restoredAlias) {
          throw new IncusError('Failed to atomically classify abandoned pre-provider route operation.', 'CONFLICT', {
            operationId: operation.id,
            aliasId: alias.id,
            revisionId: revision.id,
          })
        }
        return {
          operation: this.transition(operation.ownerId, operation.id, expectedType, operation.capsuleId, 'failed'),
          route: {
            capsuleId: restoredAlias.capsuleId,
            aliasId: restoredAlias.id,
            aliasName: restoredAlias.name,
            aliasStatus: restoredAlias.status,
            currentRevisionId: head?.revisionId ?? null,
          },
        }
      }
      const [cleanupOperation] = await tx
        .update(tables.capsuleOperations)
        .set({
          status: CapsuleOperationStatus.CLEANUP_REQUIRED,
          failedAt: now,
          failureCode: error.code,
          failureMessage: error.message,
          failureDetails: details,
          updatedAt: now,
        })
        .where(
          and(
            eq(tables.capsuleOperations.id, operation.id),
            eq(tables.capsuleOperations.type, expectedType),
            inArray(tables.capsuleOperations.status, NONTERMINAL_STATUSES),
          ),
        )
        .returning({
          id: tables.capsuleOperations.id,
        })
      if (!cleanupOperation) {
        throw new IncusError('Failed to classify abandoned route operation cleanup-required.', 'CONFLICT', {
          operationId: operation.id,
        })
      }
      if (revision?.operationId === operation.id) {
        await tx
          .update(tables.capsuleRouteRevisions)
          .set({
            status: 'cleanup_required',
            failedAt: now,
          })
          .where(
            and(eq(tables.capsuleRouteRevisions.id, revision.id), eq(tables.capsuleRouteRevisions.status, 'proposed')),
          )
      }
      if (provider && revision && provider.revisionId === revision.id) {
        await tx
          .update(tables.capsuleRouteProviderApplications)
          .set({
            status: 'cleanup_required',
            failureCode: error.code,
            failureMessage: error.message,
            failureDetails: details,
            failureAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.capsuleRouteProviderApplications.operationId, operation.id),
              inArray(tables.capsuleRouteProviderApplications.status, PROVIDER_STATUSES),
            ),
          )
      }
      let route: CommittedRouteState | null = null
      if (alias?.mutationOperationId === operation.id) {
        const [cleanupAlias] = await tx
          .update(tables.capsuleRouteAliases)
          .set({
            status: 'cleanup_required',
            mutationOperationId: null,
            lastOperationId: operation.id,
            updatedAt: now,
          })
          .where(eq(tables.capsuleRouteAliases.id, alias.id))
          .returning({
            id: tables.capsuleRouteAliases.id,
            capsuleId: tables.capsuleRouteAliases.capsuleId,
            name: tables.capsuleRouteAliases.name,
            status: tables.capsuleRouteAliases.status,
          })
        if (cleanupAlias) {
          route = {
            capsuleId: cleanupAlias.capsuleId,
            aliasId: cleanupAlias.id,
            aliasName: cleanupAlias.name,
            aliasStatus: cleanupAlias.status,
            currentRevisionId: head?.revisionId ?? null,
          }
        }
      }
      return {
        operation: this.transition(
          operation.ownerId,
          operation.id,
          expectedType,
          operation.capsuleId,
          'cleanup_required',
        ),
        route,
      }
    })
  }

  private transition(
    ownerId: string,
    operationId: string,
    operationType: CapsuleOperationTypeValue,
    capsuleId: string,
    operationStatus: 'failed' | 'cleanup_required',
  ): CapsuleOperationTransitionOutput {
    return toCapsuleOperationTransition({
      ownerId,
      operationId,
      operationType,
      operationStatus,
      capsuleId,
    })
  }
}
