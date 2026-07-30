import { and, eq } from 'drizzle-orm'
import type { CapsulePersistence, CapsuleTables } from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import type { PreviewRecord } from '../types'
import type { PreviewLocks } from './locks'

export interface PreviewFailureTransition {
  preview: PreviewRecord
  changed: boolean
}

/**
 * Owns fail-closed preview classification.
 *
 * Cleanup is guarded by the caller's observed status and updated timestamp. A
 * stale reconciliation attempt cannot overwrite a newer inactive, recovered,
 * active, degraded, or otherwise advanced durable state.
 */
export class PreviewFailurePersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: PreviewLocks<TDatabase, TTables>,
  ) {}

  public async cleanup(
    observed: PreviewRecord,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<PreviewFailureTransition> {
    return await this.persistence.db.transaction(async tx => {
      const current = (await this.locks.preview(tx, observed.id)).preview
      if (current.status === 'cleanup_required') {
        return {
          preview: current,
          changed: false,
        }
      }
      if (current.status !== observed.status || current.updatedAt.getTime() !== observed.updatedAt.getTime()) {
        return {
          preview: current,
          changed: false,
        }
      }
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const details = createFailureDetails(error, context) ?? {
        context,
      }
      const [record] = await tx
        .update(previews)
        .set({
          status: 'cleanup_required',
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Branch preview requires manual cleanup.'),
          failureDetails: toJsonObject(details, 'branch preview cleanup-required details'),
          failureAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(previews.id, observed.id),
            eq(previews.status, observed.status),
            eq(previews.updatedAt, observed.updatedAt),
          ),
        )
        .returning()
      if (!record) {
        const latest = (await this.locks.preview(tx, observed.id)).preview
        return {
          preview: latest,
          changed: false,
        }
      }
      return {
        preview: record,
        changed: true,
      }
    })
  }
}
