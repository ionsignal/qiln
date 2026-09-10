import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  CapsuleSnapshotResourceReferenceSchema,
  type CapsuleBlueprint,
  type CapsuleRootfsImagePin,
} from '@qiln/core/server'
import { IncusError } from '../../../../errors'
import { interpolate } from '../../../../utils/template'
import { mergeCloudInit } from '../../resource/bootstrap/cloudinit'
import { resolveFileTarget, type ManagedVolume } from '../../resource/bootstrap/targets'
import {
  bindMountResourceKey,
  branchInstanceName,
  branchVolumeName,
  instanceResourceKey,
  projectResourceKey,
  provisioningFileResourceKey,
  volumeResourceKey,
} from '../../resource/identity'
import {
  assertCapsuleBranchResourceInventoryMatches,
  createCapsuleBranchResourceInventoryDigest,
} from '../../resource/inventory'
import { createProvisioningFileResourceMetadata } from '../../resource/metadata'
import type {
  ForkBindResource,
  ForkFileResource,
  ForkInstanceResource,
  ForkPlan,
  ForkPlannedResource,
  ForkProjectResource,
  ForkResourceProofInput,
  ForkResourceProofStage,
  ForkResourceRecord,
  ForkSource,
  ForkVolumeResource,
} from './types'
import type { IncusDeviceMap } from '../../../../incus/client'

export interface ForkPlanInput {
  operationId: string
  ownerId: string
  branchId: string
  branchName: string
  cpu: string
  memory: string
  source: ForkSource
}

function compare(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function referenceMap(operationId: string, source: ForkSource) {
  const references = new Map<string, (typeof source.resources)[number]>()
  const sourceResources = new Set<string>()
  const createResources = new Set<string>()
  const providerIdentities = new Set<string>()
  for (const value of source.resources) {
    const resource = CapsuleSnapshotResourceReferenceSchema.parse(value)
    const providerIdentity = JSON.stringify([
      resource.provider,
      resource.kind,
      resource.project,
      resource.pool,
      resource.sourceVolume,
      resource.snapshotName,
    ])
    if (
      references.has(resource.blueprintVolumeName) ||
      sourceResources.has(resource.sourceBranchResourceId) ||
      createResources.has(resource.createResourceId) ||
      providerIdentities.has(providerIdentity)
    ) {
      throw new IncusError('Fork source contains duplicate managed-volume restoration authority.', 'CONFLICT', {
        operationId,
        sourceSnapshotId: source.snapshotId,
        blueprintVolumeName: resource.blueprintVolumeName,
      })
    }
    references.set(resource.blueprintVolumeName, resource)
    sourceResources.add(resource.sourceBranchResourceId)
    createResources.add(resource.createResourceId)
    providerIdentities.add(providerIdentity)
  }
  return references
}

/**
 * Builds the complete target branch resource plan from one committed snapshot.
 *
 * Managed volume sources come only from committed snapshot references. Rootfs
 * reconstruction authority comes only from the snapshot's immutable resolved
 * image pin. This planner performs no SQL, provider discovery, provider reads,
 * or provider mutations.
 */
export class ForkPlanner {
  public create(input: ForkPlanInput): ForkPlan {
    const blueprint = input.source.blueprint.blueprint
    if (input.source.ownerId !== input.ownerId) {
      throw new IncusError('Fork source does not belong to the target branch owner.', 'CONFLICT', {
        operationId: input.operationId,
        sourceSnapshotId: input.source.snapshotId,
      })
    }
    const namespace = `user-${input.ownerId}`
    const references = referenceMap(input.operationId, input.source)
    const project = this.project(namespace)
    const binds: ForkBindResource[] = []
    const volumes: ForkVolumeResource[] = []
    const devices: IncusDeviceMap = {
      ...blueprint.runtime.devices,
    }
    const managedVolumes: ManagedVolume[] = []
    for (const volume of blueprint.provisioning.volumes) {
      if (volume.type === 'bind') {
        devices[volume.name] = {
          type: 'disk',
          source: volume.host_path,
          path: volume.mount_path,
          readonly: volume.readonly ? 'true' : 'false',
          shift: volume.shifted ? 'true' : 'false',
        }
        binds.push({
          kind: 'bind',
          deviceName: volume.name,
          hostPath: volume.host_path,
          mountPath: volume.mount_path,
          readonly: volume.readonly,
          shifted: volume.shifted,
          provider: 'incus',
          resourceType: CapsuleBranchResourceType.BIND_MOUNT,
          resourceKey: bindMountResourceKey(namespace, volume.host_path, volume.mount_path),
          blueprintVolumeName: volume.name,
          cleanupPolicy: CapsuleBranchResourceCleanupPolicy.EXTERNAL,
          metadata: {
            namespace,
            hostPath: volume.host_path,
            mountPath: volume.mount_path,
            readonly: volume.readonly,
            shifted: volume.shifted,
          },
        })
        continue
      }
      const reference = references.get(volume.name)
      if (!reference) {
        throw new IncusError('Fork managed volume has no committed snapshot authority.', 'CONFLICT', {
          operationId: input.operationId,
          sourceSnapshotId: input.source.snapshotId,
          blueprintVolumeName: volume.name,
        })
      }
      if (
        reference.provider !== 'incus' ||
        reference.kind !== 'custom_volume_snapshot' ||
        reference.project !== namespace ||
        reference.pool !== volume.pool
      ) {
        throw new IncusError('Fork managed-volume snapshot authority is contradictory.', 'CONFLICT', {
          operationId: input.operationId,
          sourceSnapshotId: input.source.snapshotId,
          blueprintVolumeName: volume.name,
          sourceProject: reference.project,
          sourcePool: reference.pool,
        })
      }
      const volumeName = branchVolumeName(input.branchId, volume.name)
      const config: Record<string, string> = {}
      if (volume.shifted) {
        config['security.shifted'] = 'true'
      }
      const planned: ForkVolumeResource = {
        kind: 'volume',
        deviceName: volume.name,
        pool: volume.pool,
        volumeName,
        mountPath: volume.mount_path,
        readonly: volume.readonly,
        shifted: volume.shifted,
        config,
        source: {
          project: reference.project,
          pool: reference.pool,
          volume: reference.sourceVolume,
          snapshot: reference.snapshotName,
        },
        provider: 'incus',
        resourceType: CapsuleBranchResourceType.ZFS_VOLUME,
        resourceKey: volumeResourceKey(namespace, volume.pool, volumeName),
        blueprintVolumeName: volume.name,
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
        metadata: {
          namespace,
          pool: volume.pool,
          volumeName,
          mountPath: volume.mount_path,
          sourceVolume: `${reference.sourceVolume}/${reference.snapshotName}`,
          volumeType: 'clone',
        },
      }
      volumes.push(planned)
      managedVolumes.push({
        pool: volume.pool,
        volumeName,
        mountPath: volume.mount_path,
      })
      devices[volume.name] = {
        type: 'disk',
        pool: volume.pool,
        source: volumeName,
        path: volume.mount_path,
        readonly: volume.readonly ? 'true' : 'false',
      }
    }

    this.assertCoverage(input, volumes)

    managedVolumes.sort((left, right) => right.mountPath.length - left.mountPath.length)

    const instance = this.instance(
      input.branchId,
      input.branchName,
      input.cpu,
      input.memory,
      blueprint,
      input.source.rootfsImagePin,
      namespace,
      devices,
      managedVolumes,
    )
    const files = this.files(input.branchName, input.cpu, input.memory, blueprint, namespace, instance, managedVolumes)
    const resources: ForkPlannedResource[] = [
      project,
      ...binds.sort((left, right) => compare(left.resourceKey, right.resourceKey)),
      ...volumes.sort((left, right) => compare(left.resourceKey, right.resourceKey)),
      instance,
      ...files.sort((left, right) => compare(left.resourceKey, right.resourceKey)),
    ]
    const inventoryDigest = createCapsuleBranchResourceInventoryDigest(
      resources.map(resource => ({
        provider: resource.provider,
        resourceType: resource.resourceType,
        resourceKey: resource.resourceKey,
        blueprintVolumeName: resource.blueprintVolumeName,
        cleanupPolicy: resource.cleanupPolicy,
        metadata: resource.metadata,
      })),
      'capsule fork target branch resource inventory',
    )
    return {
      project,
      binds,
      volumes,
      instance,
      files,
      resources,
      inventoryDigest,
    }
  }

  /**
   * Proves that locked target branch resources still exactly match immutable
   * fork input and have reached the expected stage-specific durable outcomes.
   *
   * The inventory digest establishes exact provider, type, key, Blueprint
   * volume identity, cleanup policy, and metadata agreement. Per-row checks
   * establish mutable ownership, operation provenance, and lifecycle outcomes.
   */
  public assertResources(input: ForkResourceProofInput): void {
    if (
      input.plan.inventoryDigest !== input.extensionInventoryDigest ||
      input.branchInventoryDigest !== input.extensionInventoryDigest
    ) {
      throw new IncusError('Fork target branch inventory proof does not match immutable fork input.', 'CONFLICT', {
        operationId: input.operationId,
        branchId: input.branchId,
        stage: input.stage,
        plannedInventoryDigest: input.plan.inventoryDigest,
        extensionInventoryDigest: input.extensionInventoryDigest,
        branchInventoryDigest: input.branchInventoryDigest,
      })
    }
    if (input.resources.length !== input.plan.resources.length) {
      throw new IncusError(
        'Fork target branch resource accounting does not cover the complete immutable plan.',
        'CONFLICT',
        {
          operationId: input.operationId,
          branchId: input.branchId,
          stage: input.stage,
          expectedResourceCount: input.plan.resources.length,
          actualResourceCount: input.resources.length,
        },
      )
    }
    const plannedByKey = new Map<string, ForkPlannedResource>()
    for (const planned of input.plan.resources) {
      if (plannedByKey.has(planned.resourceKey)) {
        throw new IncusError('Fork immutable resource plan contains a duplicate resource key.', 'CONFLICT', {
          operationId: input.operationId,
          branchId: input.branchId,
          stage: input.stage,
          resourceKey: planned.resourceKey,
        })
      }
      plannedByKey.set(planned.resourceKey, planned)
    }
    const resourcesByKey = new Map<string, ForkResourceRecord>()
    for (const resource of input.resources) {
      if (resourcesByKey.has(resource.resourceKey)) {
        throw new IncusError('Fork target branch resource accounting contains a duplicate resource key.', 'CONFLICT', {
          operationId: input.operationId,
          branchId: input.branchId,
          stage: input.stage,
          resourceKey: resource.resourceKey,
        })
      }
      resourcesByKey.set(resource.resourceKey, resource)
    }

    assertCapsuleBranchResourceInventoryMatches(
      input.extensionInventoryDigest,
      input.resources.map(resource => ({
        provider: resource.provider,
        resourceType: resource.resourceType,
        resourceKey: resource.resourceKey,
        blueprintVolumeName: resource.blueprintVolumeName,
        cleanupPolicy: resource.cleanupPolicy,
        metadata: resource.metadata,
      })),
    )

    for (const planned of input.plan.resources) {
      const resource = resourcesByKey.get(planned.resourceKey)
      if (!resource) {
        throw new IncusError(
          'Fork target branch resource accounting is missing an immutable planned resource.',
          'CONFLICT',
          {
            operationId: input.operationId,
            branchId: input.branchId,
            stage: input.stage,
            resourceKey: planned.resourceKey,
          },
        )
      }
      if (
        resource.ownerId !== input.ownerId ||
        resource.branchId !== input.branchId ||
        resource.branchName !== input.branchName ||
        resource.createdByOperationId !== input.operationId ||
        resource.lastOperationId !== input.operationId ||
        resource.provider !== planned.provider ||
        resource.resourceType !== planned.resourceType ||
        resource.blueprintVolumeName !== planned.blueprintVolumeName ||
        resource.cleanupPolicy !== planned.cleanupPolicy ||
        !this.matchesOutcome(resource, input.stage)
      ) {
        throw new IncusError(
          'Fork target branch resource does not match its immutable plan and required outcome.',
          'CONFLICT',
          {
            operationId: input.operationId,
            branchId: input.branchId,
            stage: input.stage,
            resourceId: resource.id,
            resourceKey: planned.resourceKey,
            actualStatus: resource.status,
            resourceOwnerId: resource.ownerId,
            resourceBranchId: resource.branchId,
            resourceBranchName: resource.branchName,
            createdByOperationId: resource.createdByOperationId,
            lastOperationId: resource.lastOperationId,
          },
        )
      }
    }
    for (const resource of input.resources) {
      if (!plannedByKey.has(resource.resourceKey)) {
        throw new IncusError('Fork target branch resource accounting contains an unplanned resource.', 'CONFLICT', {
          operationId: input.operationId,
          branchId: input.branchId,
          stage: input.stage,
          resourceId: resource.id,
          resourceKey: resource.resourceKey,
        })
      }
    }
  }

  private project(namespace: string): ForkProjectResource {
    return {
      kind: 'project',
      namespace,
      provider: 'incus',
      resourceType: CapsuleBranchResourceType.INCUS_PROJECT,
      resourceKey: projectResourceKey(namespace),
      blueprintVolumeName: null,
      cleanupPolicy: CapsuleBranchResourceCleanupPolicy.RETAIN,
      metadata: {
        namespace,
      },
    }
  }

  private instance(
    branchId: string,
    branchName: string,
    cpu: string,
    memory: string,
    blueprint: CapsuleBlueprint,
    rootfsImagePin: CapsuleRootfsImagePin,
    namespace: string,
    devices: IncusDeviceMap,
    managedVolumes: ManagedVolume[],
  ): ForkInstanceResource {
    const instanceName = branchInstanceName(branchId)
    const config: Record<string, string> = {
      ...blueprint.runtime.config,
      'environment.QILN_TENANT_ID': branchName,
      'limits.cpu': cpu,
      'limits.memory': memory,
    }
    if (managedVolumes.length > 0) {
      config['user.vendor-data'] = mergeCloudInit(
        config['user.vendor-data'],
        managedVolumes.map(volume => ['chown', '1000:1000', volume.mountPath]),
      )
    }
    return {
      kind: 'instance',
      instanceName,
      rootfsImagePin,
      config,
      devices,
      provider: 'incus',
      resourceType: CapsuleBranchResourceType.INCUS_INSTANCE,
      resourceKey: instanceResourceKey(namespace, instanceName),
      blueprintVolumeName: null,
      cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
      metadata: {
        namespace,
        instanceName,
        rootfsImagePin,
      },
    }
  }

  private files(
    branchName: string,
    cpu: string,
    memory: string,
    blueprint: CapsuleBlueprint,
    namespace: string,
    instance: ForkInstanceResource,
    managedVolumes: ManagedVolume[],
  ): ForkFileResource[] {
    const interpolation = {
      name: branchName,
      env: instance.config,
      limits: {
        cpu,
        memory: {
          raw: memory,
        },
      },
    }
    const files: ForkFileResource[] = []
    for (const file of blueprint.provisioning.files) {
      const target = resolveFileTarget(file.path, managedVolumes)
      if (target.target === 'volume') {
        // Cloning preserves edits and intentional deletions. Historical
        // provisioning entries do not prove individual files still exist.
        continue
      }
      files.push({
        kind: 'file',
        path: file.path,
        content: file.content === undefined ? '' : interpolate(file.content, interpolation),
        target,
        options: {
          uid: file.uid,
          gid: file.gid,
          mode: file.mode,
          type: file.type,
        },
        provider: 'incus',
        resourceType: CapsuleBranchResourceType.PROVISIONING_FILE,
        resourceKey: provisioningFileResourceKey(namespace, instance.instanceName, file.path, target),
        blueprintVolumeName: null,
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
        metadata: createProvisioningFileResourceMetadata(
          namespace,
          branchName,
          instance.instanceName,
          file.path,
          target,
        ),
      })
    }
    return files
  }

  private matchesOutcome(resource: ForkResourceRecord, stage: ForkResourceProofStage): boolean {
    if (stage === 'compensating') {
      // Complete identity is required before cleanup, but uncertain resources
      // must remain visible so the compensator can refuse their deletion.
      return true
    }
    if (resource.failureCode !== null || resource.failureMessage !== null || resource.failureDetails !== null) {
      return false
    }
    if (stage === 'accepted') {
      return resource.status === CapsuleBranchResourceStatus.PLANNED
    }
    const adopted =
      resource.resourceType === CapsuleBranchResourceType.INCUS_PROJECT ||
      resource.resourceType === CapsuleBranchResourceType.BIND_MOUNT
    if (stage === 'completed') {
      return resource.status === (adopted ? CapsuleBranchResourceStatus.ADOPTED : CapsuleBranchResourceStatus.CREATED)
    }
    if (adopted) {
      return (
        resource.status === CapsuleBranchResourceStatus.PLANNED ||
        resource.status === CapsuleBranchResourceStatus.ADOPTED
      )
    }
    if (resource.resourceType === CapsuleBranchResourceType.PROVISIONING_FILE) {
      return (
        resource.status === CapsuleBranchResourceStatus.PLANNED ||
        resource.status === CapsuleBranchResourceStatus.DELETED
      )
    }
    return (
      resource.status === CapsuleBranchResourceStatus.PLANNED ||
      resource.status === CapsuleBranchResourceStatus.DELETED ||
      resource.status === CapsuleBranchResourceStatus.MISSING
    )
  }

  private assertCoverage(input: ForkPlanInput, volumes: readonly ForkVolumeResource[]): void {
    const managedNames = new Set(
      input.source.blueprint.blueprint.provisioning.volumes
        .filter(volume => volume.type !== 'bind')
        .map(volume => volume.name),
    )
    const plannedNames = new Set(volumes.map(volume => volume.blueprintVolumeName))
    const referenceNames = new Set(input.source.resources.map(resource => resource.blueprintVolumeName))
    if (
      volumes.length !== managedNames.size ||
      plannedNames.size !== managedNames.size ||
      input.source.resources.length !== managedNames.size ||
      referenceNames.size !== managedNames.size ||
      [...managedNames].some(name => !plannedNames.has(name) || !referenceNames.has(name))
    ) {
      throw new IncusError('Fork snapshot references do not exactly cover all managed Blueprint volumes.', 'CONFLICT', {
        operationId: input.operationId,
        sourceSnapshotId: input.source.snapshotId,
        managedBlueprintVolumes: [...managedNames].sort(compare),
        plannedBlueprintVolumes: [...plannedNames].sort(compare),
        referencedBlueprintVolumes: [...referenceNames].sort(compare),
      })
    }
  }
}
