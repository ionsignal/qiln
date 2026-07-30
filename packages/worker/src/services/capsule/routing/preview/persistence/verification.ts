import { and, eq, inArray } from 'drizzle-orm'
import {
  CapsuleRouteVerificationEvidenceSchema,
  type CapsulePersistence,
  type CapsuleRouteVerificationEvidence,
  type CapsuleTables,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import { createFailureDetails, failureCodeFromUnknown, failureMessageFromUnknown } from '../../../failures'
import { toJsonObject } from '../../../persistence/json'
import type { PreviewRecord } from '../types'
import type { PreviewLocks } from './locks'

const ACTIVATABLE_STATUSES = ['verifying', 'degraded'] as const
const DEGRADEABLE_STATUSES = ['active', 'degraded', 'verifying'] as const

/**
 * Owns durable route-verification outcomes for one confirmed current preview
 * configuration.
 */
export class PreviewVerificationPersistence<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly locks: PreviewLocks<TDatabase, TTables>,
  ) {}

  public async active(id: string, evidence: CapsuleRouteVerificationEvidence): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = (await this.locks.preview(tx, id)).preview
      if (!ACTIVATABLE_STATUSES.includes(preview.status as (typeof ACTIVATABLE_STATUSES)[number])) {
        throw new IncusError('Branch preview is not waiting for route verification.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }
      const configurationDigest = this.currentDigest(preview)
      const verified = CapsuleRouteVerificationEvidenceSchema.parse(evidence)
      if (verified.configurationDigest !== configurationDigest) {
        throw new IncusError(
          'Branch preview verification evidence does not match its current configuration.',
          'CONFLICT',
          {
            previewId: id,
            expectedConfigurationDigest: configurationDigest,
            actualConfigurationDigest: verified.configurationDigest,
          },
        )
      }
      const previews = this.persistence.tables.capsuleBranchPreviews
      const verifiedAt = new Date(verified.verifiedAt)
      const [record] = await tx
        .update(previews)
        .set({
          status: 'active',
          verificationEvidence: verified,
          verifiedAt,
          failureCode: null,
          failureMessage: null,
          failureDetails: null,
          failureAt: null,
          updatedAt: verifiedAt,
        })
        .where(
          and(
            eq(previews.id, id),
            inArray(previews.status, ACTIVATABLE_STATUSES),
            eq(previews.updatedAt, preview.updatedAt),
          ),
        )
        .returning()
      return this.require(record, id, 'active')
    })
  }

  public async degraded(id: string, error: unknown, context: Record<string, unknown>): Promise<PreviewRecord> {
    return await this.persistence.db.transaction(async tx => {
      const preview = (await this.locks.preview(tx, id)).preview
      if (!DEGRADEABLE_STATUSES.includes(preview.status as (typeof DEGRADEABLE_STATUSES)[number])) {
        throw new IncusError('Branch preview cannot enter degraded state from its current status.', 'CONFLICT', {
          previewId: id,
          status: preview.status,
        })
      }
      this.currentDigest(preview)
      const previews = this.persistence.tables.capsuleBranchPreviews
      const now = new Date()
      const details = createFailureDetails(error, context) ?? {
        context,
      }
      const [record] = await tx
        .update(previews)
        .set({
          status: 'degraded',
          verificationIntentAt: now,
          verificationEvidence: null,
          verifiedAt: null,
          failureCode: failureCodeFromUnknown(error),
          failureMessage: failureMessageFromUnknown(error, 'Branch preview verification failed.'),
          failureDetails: toJsonObject(details, 'branch preview degraded details'),
          failureAt: now,
          updatedAt: now,
        })
        .where(and(eq(previews.id, id), eq(previews.status, preview.status), eq(previews.updatedAt, preview.updatedAt)))
        .returning()
      return this.require(record, id, 'degraded')
    })
  }

  private currentDigest(preview: PreviewRecord): string {
    if (
      preview.currentRuntimeIp === null ||
      preview.currentConfigurationKey === null ||
      preview.currentConfigurationDigest === null ||
      preview.currentConfiguration === null ||
      preview.appliedAt === null
    ) {
      throw new IncusError('Branch preview has no confirmed current Caddy configuration.', 'CONFLICT', {
        previewId: preview.id,
        status: preview.status,
      })
    }
    return preview.currentConfigurationDigest
  }

  private require(record: PreviewRecord | undefined, previewId: string, status: string): PreviewRecord {
    if (!record) {
      throw new IncusError(`Failed to transition branch preview to '${status}'.`, 'CONFLICT', {
        previewId,
        status,
      })
    }
    return record
  }
}
