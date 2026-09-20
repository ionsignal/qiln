import { ZodError } from 'zod'
import {
  CapsuleDetailSchema,
  CapsuleListOutputSchema,
  CapsuleManifestUnavailableReason,
  CapsuleRouteHostSchema,
  CapsuleRouteVerificationEvidenceSchema,
  createCapsuleBlueprintReference,
  createCapsuleRouteApplicationPin,
  digestCapsuleRouteConfiguration,
  GlobalError,
  GlobalErrorCode,
  verifyCapsuleRouteApplicationPin,
  type CapsuleDetail,
  type CapsuleListOutput,
  type CapsuleManifest,
  type CapsulePreview,
  type CapsuleStorageBoundary,
  type CapsuleSummary,
} from '@qiln/core/server'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { CapsuleTables } from '@qiln/core/server'
import { IncusError } from '../../../errors'
import type { CapsuleBranchProvenance, CapsuleBranchProvenancePins } from '../branch/provenance'
import { toCapsuleLifecycleState } from '../operations/shared/capsuleLifecycleState'
import { operationSummary } from '../operations/shared/summary'
import { toIsoTimestamp, toNullableIsoTimestamp } from '../operations/shared/timestamps'
import { PreviewPlanner } from '../routing/preview/plan'
import type { CapsuleReadStore } from './store'
import type { BranchRow, CapsuleReadScope, PreviewRow, ReadTransaction } from './types'
import type { PreviewUrl } from './url'

type ProvenanceResult =
  | {
      available: true
      pins: CapsuleBranchProvenancePins
    }
  | {
      available: false
      reason: CapsuleManifestUnavailableReason
    }

/**
 * Capsule projections use only durable, consistently read evidence. They do not
 * inspect provider health or infer anatomy from the mutable catalog.
 */
export class CapsuleReadService<
  TDatabase extends PostgresJsDatabase = PostgresJsDatabase,
  TTables extends CapsuleTables = CapsuleTables,
> {
  private readonly planner = new PreviewPlanner()

  constructor(
    private readonly store: CapsuleReadStore<TDatabase, TTables>,
    private readonly provenance: CapsuleBranchProvenance<TDatabase, TTables>,
    private readonly urls: PreviewUrl,
  ) {}

  public async list(ownerId: string): Promise<CapsuleListOutput> {
    return await this.store.read(async tx => {
      const scopes = await this.store.list(tx, ownerId)
      const summaries: CapsuleSummary[] = []
      for (const scope of scopes) {
        const evidence = scope.previews.length === 0 ? null : await this.readProvenance(tx, scope.branch)
        summaries.push({
          capsule: this.lifecycle(scope),
          rootBranch: {
            ...this.runtime(scope.root),
            isRootBranch: true,
          },
          previews: this.previews(scope, evidence?.available ? evidence.pins : null),
          currentOperation: scope.operation === null ? null : this.current(scope),
        })
      }
      return CapsuleListOutputSchema.parse(summaries)
    })
  }

  public async detail(ownerId: string, capsuleId: string, branchId?: string): Promise<CapsuleDetail> {
    return await this.store.read(async tx => {
      const scope = await this.store.detail(tx, ownerId, capsuleId, branchId)
      const evidence = await this.readProvenance(tx, scope.branch)
      return CapsuleDetailSchema.parse({
        capsule: this.lifecycle(scope),
        rootBranch: {
          id: scope.root.id,
          name: scope.root.name,
          isRootBranch: true,
        },
        branch: this.runtime(scope.branch),
        manifest: this.manifest(scope.branch, evidence),
        previews: this.previews(scope, evidence.available ? evidence.pins : null),
        currentOperation: scope.operation === null ? null : this.current(scope),
      })
    })
  }

  private lifecycle(scope: CapsuleReadScope) {
    return toCapsuleLifecycleState({
      capsuleId: scope.capsule.id,
      lifecycleStatus: scope.capsule.lifecycleStatus,
      archivedAt: scope.capsule.archivedAt,
      destroyedAt: scope.capsule.destroyedAt,
    })
  }

  private runtime(branch: BranchRow) {
    return {
      id: branch.id,
      name: branch.name,
      isRootBranch: branch.isRootBranch,
      status: branch.status,
      runtimeIp: branch.runtimeIp,
    }
  }

  private current(scope: CapsuleReadScope) {
    const operation = scope.operation
    if (!operation || (operation.status !== 'accepted' && operation.status !== 'running')) {
      throw new IncusError('Current capsule operation must be nonterminal.', 'CONFLICT', {
        capsuleId: scope.capsule.id,
      })
    }
    return {
      ...operationSummary(operation),
      status: operation.status,
    }
  }

  private async readProvenance(tx: ReadTransaction<TDatabase>, branch: BranchRow): Promise<ProvenanceResult> {
    if (await this.store.creationPending(tx, branch)) {
      return {
        available: false,
        reason: CapsuleManifestUnavailableReason.CREATION_NOT_COMPLETED,
      }
    }
    try {
      return {
        available: true,
        pins: await this.provenance.read(tx, branch),
      }
    } catch (error: unknown) {
      if (!this.isHistoricalFailure(error)) {
        throw error
      }
      return {
        available: false,
        reason: CapsuleManifestUnavailableReason.HISTORICAL_EVIDENCE_UNAVAILABLE,
      }
    }
  }

  private isHistoricalFailure(error: unknown): boolean {
    if (error instanceof IncusError) {
      return error.code === 'CONFLICT' || error.code === 'NOT_FOUND' || error.code === 'VALIDATION_ERROR'
    }
    if (error instanceof GlobalError) {
      return error.code === GlobalErrorCode.BAD_REQUEST || error.code === GlobalErrorCode.CONFLICT
    }
    return error instanceof ZodError
  }

  private manifest(branch: BranchRow, evidence: ProvenanceResult): CapsuleManifest {
    if (!evidence.available) {
      return {
        available: false,
        reason: evidence.reason,
      }
    }
    const blueprint = evidence.pins.blueprint.blueprint
    const gpuCount = Object.values(blueprint.runtime.devices).filter(device => device.type === 'gpu').length
    const storageBoundaries = blueprint.provisioning.volumes.map<CapsuleStorageBoundary>(volume => {
      const boundary = {
        name: volume.name,
        mountPath: volume.mount_path,
        readonly: volume.readonly,
      }
      if (volume.type === 'bind') {
        return {
          ...boundary,
          kind: 'bind',
          versioning: 'external',
        }
      }
      if (volume.type === 'clone') {
        return {
          ...boundary,
          kind: 'clone',
          versioning: 'versioned',
        }
      }
      return {
        ...boundary,
        kind: 'empty',
        versioning: volume.versioned ? 'versioned' : 'unversioned',
      }
    })
    return {
      available: true,
      manifest: {
        blueprint: createCapsuleBlueprintReference(evidence.pins.blueprint),
        rootfsImageFingerprint: evidence.pins.rootfsImagePin.fingerprint,
        cpu: branch.cpu,
        memory: branch.memory,
        gpu: {
          configured: gpuCount > 0,
          deviceCount: gpuCount,
        },
        applicationCount: blueprint.applications.length,
        storageBoundaries,
      },
    }
  }

  private previews(scope: CapsuleReadScope, pins: CapsuleBranchProvenancePins | null): CapsulePreview[] | null {
    if (scope.previews.length === 0) {
      return []
    }
    if (pins === null) {
      return null
    }
    const blueprint = createCapsuleBlueprintReference(pins.blueprint)
    return scope.previews.map(preview => {
      const application = verifyCapsuleRouteApplicationPin(preview.applicationPin)
      const historical = pins.blueprint.blueprint.applications.find(
        candidate => candidate.name === preview.applicationName,
      )
      if (
        !historical ||
        application.application.name !== preview.applicationName ||
        createCapsuleRouteApplicationPin({
          schemaVersion: application.schemaVersion,
          blueprint,
          application: historical,
        }).digest !== application.digest
      ) {
        throw new IncusError('Preview application does not match historical branch provenance.', 'CONFLICT', {
          previewId: preview.id,
          branchId: scope.branch.id,
        })
      }
      const verifiedAt = toNullableIsoTimestamp(preview.verifiedAt, 'verifiedAt', {
        entity: 'branch preview',
        entityId: preview.id,
      })
      let previewUrl: string | null = null
      if (preview.status === 'active') {
        this.assertActiveEvidence(preview)
        if (this.canOpenPreview(scope, preview)) {
          previewUrl = this.urls.create(preview.host, application.application.entrypoint)
        }
      }
      return {
        id: preview.id,
        applicationName: preview.applicationName,
        status: preview.status,
        verifiedAt,
        previewUrl,
      }
    })
  }

  /**
   * Lifecycle and runtime transitions can precede preview withdrawal. Withhold
   * the URL during that interval without treating valid historical routing
   * evidence as corruption or changing the persisted preview status.
   */
  private canOpenPreview(scope: CapsuleReadScope, preview: PreviewRow): boolean {
    return (
      scope.capsule.lifecycleStatus === 'active' &&
      scope.capsule.archivedAt === null &&
      scope.capsule.destroyedAt === null &&
      scope.branch.status === 'online' &&
      scope.branch.runtimeIp !== null &&
      preview.currentRuntimeIp === scope.branch.runtimeIp &&
      preview.withdrawalRequestedAt === null
    )
  }

  private assertActiveEvidence(preview: PreviewRow): void {
    if (
      preview.currentRuntimeIp === null ||
      preview.pendingRuntimeIp !== null ||
      preview.pendingConfigurationKey !== null ||
      preview.pendingConfigurationDigest !== null ||
      preview.pendingConfiguration !== null ||
      preview.applyIntentAt !== null ||
      preview.removeIntentAt !== null ||
      preview.currentConfiguration === null ||
      preview.currentConfigurationDigest === null ||
      preview.currentConfigurationKey !== preview.providerRouteId ||
      preview.appliedAt === null ||
      preview.verificationIntentAt === null ||
      preview.verifiedAt === null ||
      preview.failureCode !== null ||
      preview.failureMessage !== null ||
      preview.failureDetails !== null ||
      preview.failureAt !== null
    ) {
      throw new IncusError('Active preview does not have complete routing evidence.', 'CONFLICT', {
        previewId: preview.id,
        branchId: preview.branchId,
      })
    }
    CapsuleRouteHostSchema.parse(preview.host)
    const evidence = CapsuleRouteVerificationEvidenceSchema.parse(preview.verificationEvidence)
    const plan = this.planner.create(preview, preview.currentRuntimeIp)
    const digest = digestCapsuleRouteConfiguration(preview.currentConfiguration)
    const appliedAt = new Date(
      toIsoTimestamp(preview.appliedAt, 'appliedAt', { entity: 'branch preview', entityId: preview.id }),
    ).getTime()
    const intentAt = new Date(
      toIsoTimestamp(preview.verificationIntentAt, 'verificationIntentAt', {
        entity: 'branch preview',
        entityId: preview.id,
      }),
    ).getTime()
    const verifiedAt = new Date(
      toIsoTimestamp(preview.verifiedAt, 'verifiedAt', { entity: 'branch preview', entityId: preview.id }),
    ).getTime()
    if (
      digest !== preview.currentConfigurationDigest ||
      digest !== plan.configurationDigest ||
      evidence.configurationDigest !== digest ||
      !evidence.upstreamVerified ||
      !evidence.routeVerified ||
      new Date(evidence.verifiedAt).getTime() !== verifiedAt ||
      intentAt < appliedAt ||
      verifiedAt < intentAt
    ) {
      throw new IncusError('Active preview verification does not match its current route configuration.', 'CONFLICT', {
        previewId: preview.id,
        branchId: preview.branchId,
      })
    }
  }
}
