import { IncusError } from '../../../../errors'
import { failureCodeFromUnknown, failureMessageFromUnknown, normalizeFailureDetails } from '../../failures'
import type { IncusClient } from '../../../../incus/client/index'
import type { CaptureResourcePersistence } from './persistence'
import type {
  CaptureCompensationResult,
  CaptureExecutionInput,
  CaptureProviderResult,
  CaptureResourceFailure,
  CaptureResourceRecord,
  CaptureRootPlan,
} from './types'

export interface CaptureProviderDependencies {
  incus: IncusClient
  resources: CaptureResourcePersistence
}

/**
 * Performs only provider mutations authorized by the deterministic capture plan
 * and operation-scoped resource ledger.
 *
 * No provider listing, discovery, adoption, or inferred ownership is allowed.
 */
export class CaptureProvider {
  constructor(private readonly dependencies: CaptureProviderDependencies) {}

  public async create(input: CaptureExecutionInput): Promise<CaptureProviderResult> {
    const created: CaptureResourceRecord[] = []

    for (const root of input.plan.roots) {
      const resource = await this.createRoot(input.operationId, root)
      created.push(resource)
    }

    return {
      created,
    }
  }

  /**
   * Compensates only resources whose successful provider creation was durably
   * recorded as `created`.
   *
   * A resource in `creating` or `error` is intentionally not deleted because
   * Qiln cannot prove whether it owns an existing provider snapshot.
   */
  public async compensate(
    operationId: string,
    resources: readonly CaptureResourceRecord[],
  ): Promise<CaptureCompensationResult> {
    const failures: CaptureResourceFailure[] = []
    const outcomes: CaptureResourceRecord[] = []

    for (const resource of [...resources].reverse()) {
      if (resource.status !== 'created') {
        failures.push({
          resourceId: resource.id,
          artifactRootId: resource.artifactRootId,
          code: 'CAPTURE_RESOURCE_NOT_CONFIRMED_CREATED',
          message: 'Provider snapshot ownership is not proven for compensation.',
          details: {
            status: resource.status,
          },
        })
        continue
      }

      try {
        outcomes.push(await this.delete(operationId, resource))
      } catch (error: unknown) {
        const failure: CaptureResourceFailure = {
          resourceId: resource.id,
          artifactRootId: resource.artifactRootId,
          code: failureCodeFromUnknown(error),
          message: failureMessageFromUnknown(error, 'Snapshot Capture provider compensation failed.'),
        }
        const details = normalizeFailureDetails(error)
        if (details !== undefined) {
          failure.details = details
        }
        failures.push(failure)
      }
    }

    return {
      complete: failures.length === 0 && outcomes.length === resources.length,
      resources: outcomes,
      failures,
    }
  }

  private async createRoot(operationId: string, root: CaptureRootPlan): Promise<CaptureResourceRecord> {
    const creating = await this.dependencies.resources.creating(operationId, root)
    const project = this.dependencies.incus.UseProject(root.project)

    try {
      await project.storage.snapshots.create(root.pool, root.sourceVolume, root.snapshotName)
    } catch (error: unknown) {
      await this.recordErrorBestEffort(operationId, creating, error, {
        operationId,
        action: 'create_provider_snapshot',
        artifactRootId: root.artifactRootId,
        resourceId: creating.id,
        project: root.project,
        pool: root.pool,
        sourceVolume: root.sourceVolume,
        snapshotName: root.snapshotName,
        providerOutcomeUncertain: true,
      })
      throw error
    }

    try {
      return await this.dependencies.resources.created(operationId, creating.id)
    } catch (error: unknown) {
      /**
       * The provider snapshot was confirmed created, but the durable outcome
       * was not recorded. Ownership is therefore uncertain to later processes.
       * We must not issue unfenced compensation from this catch path.
       */
      console.error(
        `[CaptureProvider] Provider snapshot '${root.snapshotName}' was created, but its durable outcome could not be recorded.`,
        {
          operationId,
          artifactRootId: root.artifactRootId,
          resourceId: creating.id,
          error,
        },
      )
      throw error
    }
  }

  private async delete(operationId: string, resource: CaptureResourceRecord): Promise<CaptureResourceRecord> {
    const deleting = await this.dependencies.resources.deleting(operationId, resource.id)
    const project = this.dependencies.incus.UseProject(deleting.project)

    try {
      await project.storage.snapshots.delete(deleting.pool, deleting.sourceVolume, deleting.snapshotName)
      return await this.dependencies.resources.compensated(operationId, deleting.id, 'deleted')
    } catch (error: unknown) {
      if (this.isNotFound(error)) {
        return await this.dependencies.resources.compensated(operationId, deleting.id, 'missing')
      }

      await this.recordErrorBestEffort(operationId, deleting, error, {
        operationId,
        action: 'delete_provider_snapshot',
        artifactRootId: deleting.artifactRootId,
        resourceId: deleting.id,
        project: deleting.project,
        pool: deleting.pool,
        sourceVolume: deleting.sourceVolume,
        snapshotName: deleting.snapshotName,
        providerOutcomeUncertain: true,
      })
      throw error
    }
  }

  private async recordErrorBestEffort(
    operationId: string,
    resource: CaptureResourceRecord,
    error: unknown,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dependencies.resources.error(operationId, resource.id, error, context)
    } catch (persistenceError: unknown) {
      console.error(`[CaptureProvider] Failed to persist provider uncertainty for capture resource '${resource.id}'.`, {
        operationId,
        providerError: error,
        persistenceError,
      })
    }
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof IncusError && error.code === 'NOT_FOUND'
  }
}
