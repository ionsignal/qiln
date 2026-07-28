import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  type CapsuleBlueprint,
  type CapsuleBranchResourceStatusValue,
  type CapsuleRootfsImagePin,
  type CapsuleSnapshotCapturePolicyPin,
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

function rootMap(operationId: string, policy: CapsuleSnapshotCapturePolicyPin) {
  const roots = new Map<string, (typeof policy.artifactRoots)[number]>()
  for (const root of policy.artifactRoots) {
    if (roots.has(root.blueprintVolumeName)) {
      throw new IncusError('Fork capture policy contains duplicate managed volume authority.', 'CONFLICT', {
        operationId,
        blueprintVolumeName: root.blueprintVolumeName,
      })
    }
    roots.set(root.blueprintVolumeName, root)
  }
  return roots
}

function referenceMap(operationId: string, source: ForkSource) {
  const references = new Map<string, (typeof source.resources)[number]>()
  for (const resource of source.resources) {
    if (references.has(resource.blueprintVolumeName)) {
      throw new IncusError('Fork source contains duplicate managed volume references.', 'CONFLICT', {
        operationId,
        sourceSnapshotId: source.snapshotId,
        blueprintVolumeName: resource.blueprintVolumeName,
      })
    }
    references.set(resource.blueprintVolumeName, resource)
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
    const policy = input.source.capturePolicy
    if (
      input.source.blueprint.name !== policy.blueprintName ||
      input.source.blueprint.digest !== policy.blueprintDigest
    ) {
      throw new IncusError('Fork Blueprint and capture policy identities disagree.', 'CONFLICT', {
        operationId: input.operationId,
        sourceSnapshotId: input.source.snapshotId,
        blueprintName: input.source.blueprint.name,
        blueprintDigest: input.source.blueprint.digest,
        policyBlueprintName: policy.blueprintName,
        policyBlueprintDigest: policy.blueprintDigest,
      })
    }
    const namespace = `user-${input.ownerId}`
    const roots = rootMap(input.operationId, policy)
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
      const root = roots.get(volume.name)
      const reference = references.get(volume.name)
      if (!root || !reference) {
        throw new IncusError('Fork managed volume has no committed snapshot authority.', 'CONFLICT', {
          operationId: input.operationId,
          sourceSnapshotId: input.source.snapshotId,
          blueprintVolumeName: volume.name,
          artifactRootId: root?.id ?? null,
          snapshotReferenceId: reference?.id ?? null,
        })
      }
      if (
        reference.artifactRootId !== root.id ||
        reference.provider !== 'incus' ||
        reference.kind !== 'custom_volume_snapshot'
      ) {
        throw new IncusError('Fork managed volume snapshot authority is contradictory.', 'CONFLICT', {
          operationId: input.operationId,
          sourceSnapshotId: input.source.snapshotId,
          blueprintVolumeName: volume.name,
          policyArtifactRootId: root.id,
          referenceArtifactRootId: reference.artifactRootId,
          provider: reference.provider,
          kind: reference.kind,
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
        artifactRootId: root.id,
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
    const resourcesByKey = new Map<string, (typeof input.resources)[number]>()
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
      const expectedStatus = this.resourceStatus(planned, input.stage)
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
        resource.status !== expectedStatus ||
        resource.failureCode !== null ||
        resource.failureMessage !== null ||
        resource.failureDetails !== null
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
            expectedStatus,
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
    return blueprint.provisioning.files.map(file => {
      const target = resolveFileTarget(file.path, managedVolumes)
      return {
        kind: 'file',
        path: file.path,
        content: file.content === undefined ? '' : interpolate(file.content, interpolation),
        target,
        restoredByClone: target.target === 'volume',
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
      }
    })
  }

  private resourceStatus(
    resource: ForkPlannedResource,
    stage: ForkResourceProofStage,
  ): CapsuleBranchResourceStatusValue {
    if (stage === 'accepted') {
      return CapsuleBranchResourceStatus.PLANNED
    }
    if (
      resource.resourceType === CapsuleBranchResourceType.INCUS_PROJECT ||
      resource.resourceType === CapsuleBranchResourceType.BIND_MOUNT
    ) {
      return CapsuleBranchResourceStatus.ADOPTED
    }
    if (
      resource.resourceType === CapsuleBranchResourceType.INCUS_INSTANCE ||
      resource.resourceType === CapsuleBranchResourceType.ZFS_VOLUME ||
      resource.resourceType === CapsuleBranchResourceType.PROVISIONING_FILE
    ) {
      return CapsuleBranchResourceStatus.CREATED
    }
    throw new IncusError('Fork immutable resource plan contains an unsupported resource type.', 'CONFLICT', {
      resourceKey: resource.resourceKey,
      resourceType: resource.resourceType,
      stage,
    })
  }

  private assertCoverage(input: ForkPlanInput, volumes: readonly ForkVolumeResource[]): void {
    const plannedNames = new Set(volumes.map(volume => volume.blueprintVolumeName))
    const policyNames = new Set(input.source.capturePolicy.artifactRoots.map(root => root.blueprintVolumeName))
    const referenceNames = new Set(input.source.resources.map(resource => resource.blueprintVolumeName))
    if (
      plannedNames.size !== policyNames.size ||
      plannedNames.size !== referenceNames.size ||
      [...policyNames].some(name => !plannedNames.has(name)) ||
      [...referenceNames].some(name => !plannedNames.has(name))
    ) {
      throw new IncusError('Fork snapshot references do not exactly cover all managed Blueprint volumes.', 'CONFLICT', {
        operationId: input.operationId,
        sourceSnapshotId: input.source.snapshotId,
        plannedBlueprintVolumes: [...plannedNames].sort(compare),
        policyBlueprintVolumes: [...policyNames].sort(compare),
        referencedBlueprintVolumes: [...referenceNames].sort(compare),
      })
    }
  }
}
