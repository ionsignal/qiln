import { eq } from 'drizzle-orm'
import type {
  CapsuleDestroyObservation,
  CapsulePersistence,
  CapsuleTables,
} from '@qiln/core/server'
import { CaddyError, CaddyErrorCode, type CaddyClient, type CaddyRecoveryBinding } from '../../../../../caddy'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { IncusError } from '../../../../../errors'
import type { DestroyTargets } from '../persistence/targets'
import type { DestroyExecution, DestroyTarget } from '../types'

/**
 * Recovery removes an exact durably attributed route ID, even when its current
 * configuration has drifted. Ordinary preview route schemas are not involved.
 */
export class DestroyRoutes<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  constructor(
    private readonly persistence: CapsulePersistence<TDatabase, TTables>,
    private readonly caddy: CaddyClient,
    private readonly targets: DestroyTargets<TDatabase, TTables>,
  ) {}

  public async withdraw(execution: DestroyExecution): Promise<void> {
    for (const resource of execution.targets) {
      if (resource.target.kind === 'route') {
        await this.remove(execution, resource)
      }
    }
  }

  private async remove(execution: DestroyExecution, resource: DestroyTarget): Promise<void> {
    const binding: CaddyRecoveryBinding = {
      operationId: execution.operationId,
      resourceId: resource.id,
      resource: {
        target: resource.target,
        proof: resource.proof,
      },
    }
    const historical = await this.history(resource)
    let state: Awaited<ReturnType<CaddyClient['recovery']['read']>>
    let before: CapsuleDestroyObservation
    try {
      state = await this.caddy.recovery.read()
      const observation = this.caddy.recovery.inspect(binding, state)
      const digest = observation.details.configurationDigest
      before = {
        ...observation,
        details: {
          ...observation.details,
          historical,
          configurationMismatch: observation.state === 'present' &&
            (typeof digest !== 'string' || !historical.configurationDigests.includes(digest)),
        },
      }
    } catch (error: unknown) {
      await this.targets.inspect(execution.operationId, resource.id, this.unresolved(resource))
      throw error
    }
    await this.targets.inspect(execution.operationId, resource.id, before)
    if (before.state === 'absent') {
      return
    }
    await this.targets.intent(execution.operationId, resource.id)
    let mutationError: unknown
    try {
      await this.caddy.recovery.delete(binding, state)
    } catch (error: unknown) {
      mutationError = error
    }
    if (this.requiresManualRouteArrayInspection(mutationError)) {
      throw mutationError
    }
    let after: CapsuleDestroyObservation
    try {
      after = this.caddy.recovery.inspect(binding, await this.caddy.recovery.read())
    } catch (error: unknown) {
      await this.targets.settle(execution.operationId, resource.id, this.unresolved(resource))
      throw error
    }
    await this.targets.settle(execution.operationId, resource.id, after)
    if (after.state !== 'absent') {
      throw new IncusError('Caddy route remains present after withdrawal.', 'CONFLICT', {
        resourceId: resource.id,
        mutationFailed: mutationError !== undefined,
      })
    }
  }

  // Target absence cannot erase evidence that the Caddy write changed
  // unrelated route-array entries unexpectedly.
  private requiresManualRouteArrayInspection(error: unknown): error is CaddyError {
    return error instanceof CaddyError && error.code === CaddyErrorCode.CONFIGURATION_MISMATCH
  }

  /**
   * Retain prior mutable preview diagnostics before clearing derived preview
   * state. Full earlier operation and revision records remain unchanged.
   */
  private async history(resource: DestroyTarget): Promise<{
    configurationDigests: string[]
    preview?: {
      host: string
      status: string
      failureCode: string | null
      failureAt: string | null
    }
  }> {
    const t = this.persistence.tables
    if (resource.proof.source === 'preview') {
      const [preview] = await this.persistence.db.select().from(t.capsuleBranchPreviews)
        .where(eq(t.capsuleBranchPreviews.id, resource.proof.previewId)).limit(1)
      if (!preview) {
        throw new IncusError('Historical preview evidence disappeared before withdrawal.', 'CONFLICT')
      }
      return {
        configurationDigests: [preview.currentConfigurationDigest, preview.pendingConfigurationDigest]
          .filter((digest): digest is string => digest !== null),
        preview: {
          host: preview.host,
          status: preview.status,
          failureCode: preview.failureCode,
          failureAt: preview.failureAt?.toISOString() ?? null,
        },
      }
    }
    if (resource.proof.source !== 'alias') {
      throw new IncusError('Route withdrawal requires preview or alias provenance.', 'CONFLICT')
    }
    const rows = await this.persistence.db.select({
      digest: t.capsuleRouteProviderApplications.configurationDigest,
    }).from(t.capsuleRouteRevisions).innerJoin(
      t.capsuleRouteProviderApplications,
      eq(t.capsuleRouteProviderApplications.revisionId, t.capsuleRouteRevisions.id),
    ).where(eq(t.capsuleRouteRevisions.aliasId, resource.proof.aliasId))
    return {
      configurationDigests: rows.flatMap(row => row.digest === null ? [] : [row.digest]),
    }
  }

  private unresolved(resource: DestroyTarget): CapsuleDestroyObservation {
    return {
      target: resource.target,
      state: 'unresolved',
      observedAt: new Date().toISOString(),
      details: { reason: 'caddy_observation_unresolved' },
    }
  }
}
