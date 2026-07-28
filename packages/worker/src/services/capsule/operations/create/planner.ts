import { CapsuleBranchResourceCleanupPolicy, CapsuleBranchResourceType, type CapsuleBlueprint } from '@qiln/core/server'
import { interpolate } from '../../../../utils/template'
import {
  bindMountResourceKey,
  branchInstanceName,
  branchVolumeName,
  instanceResourceKey,
  projectResourceKey,
  provisioningFileResourceKey,
  volumeResourceKey,
} from '../../resource/identity'
import { createProvisioningFileResourceMetadata } from '../../resource/metadata'
import { mergeCloudInit } from '../../resource/bootstrap/cloudinit'
import { resolveFileTarget, type ManagedVolume } from '../../resource/bootstrap/targets'
import type { CapsuleBranchResourceInventoryEntry } from '../../resource/inventory'
import type {
  CreateCapsuleBindMountResource,
  CreateCapsuleProvisioningFileResource,
  CreateCapsuleResourcePlan,
  CreateCapsuleResourcePlanInput,
  CreateCapsuleVolumeResource,
} from './types'
import type { IncusDeviceMap } from '../../../../incus/client'

const SOURCE_PROJECT = 'default'

/**
 * Maps a deterministic create plan into the immutable resource identity set
 * whose digest is committed before the operation-wide provider-intent fence.
 *
 * Runtime resource status is deliberately excluded because the inventory proof
 * describes planned ownership identity rather than mutable provider progress.
 */
export function createResourceInventoryEntries(plan: CreateCapsuleResourcePlan): CapsuleBranchResourceInventoryEntry[] {
  return [plan.project, ...plan.bindMounts, ...plan.volumes, plan.instance, ...plan.files].map(resource => ({
    provider: 'incus',
    resourceType: resource.resourceType,
    resourceKey: resource.resourceKey,
    blueprintVolumeName: resource.blueprintVolumeName,
    cleanupPolicy: resource.cleanupPolicy,
    metadata: resource.metadata,
  }))
}

/**
 * Produces the deterministic provider-resource plan for a capsule root branch.
 *
 * User-facing branch names remain product identities. Incus instance and volume
 * names are derived from the durable branch UUID so equal branch names in
 * different capsules cannot collide inside one owner project.
 *
 * `rootfsImagePin` is immutable create-time reconstruction authority. The
 * Blueprint alias remains audit evidence only and must not be resolved during
 * provider execution.
 */
export class CreateCapsuleResourcePlanner {
  public createPlan(input: CreateCapsuleResourcePlanInput): CreateCapsuleResourcePlan {
    const { namespace, rootBranchId, rootBranchName, cpu, memory, blueprint, rootfsImagePin } = input
    const instanceName = branchInstanceName(rootBranchId)
    const dynamicDevices: IncusDeviceMap = {}
    const bindMounts: CreateCapsuleBindMountResource[] = []
    const volumes: CreateCapsuleVolumeResource[] = []
    const managedVolumes: ManagedVolume[] = []

    for (const volume of blueprint.provisioning.volumes) {
      const volumeName = branchVolumeName(rootBranchId, volume.name)

      if (volume.type === 'bind') {
        dynamicDevices[volume.name] = {
          type: 'disk',
          source: volume.host_path,
          path: volume.mount_path,
          readonly: volume.readonly ? 'true' : 'false',
          shift: volume.shifted ? 'true' : 'false',
        }

        bindMounts.push({
          kind: 'bindMount',
          deviceName: volume.name,
          hostPath: volume.host_path,
          mountPath: volume.mount_path,
          readonly: volume.readonly,
          shifted: volume.shifted,
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

      const config: Record<string, string> = {}

      if (volume.shifted) {
        config['security.shifted'] = 'true'
      }

      volumes.push({
        kind: 'volume',
        volumeType: volume.type,
        deviceName: volume.name,
        pool: volume.pool,
        volumeName,
        mountPath: volume.mount_path,
        readonly: volume.readonly,
        shifted: volume.shifted,
        sourceVolume: volume.type === 'clone' ? volume.source_volume : null,
        sourceProject: volume.type === 'clone' ? SOURCE_PROJECT : undefined,
        config,
        resourceType: CapsuleBranchResourceType.ZFS_VOLUME,
        resourceKey: volumeResourceKey(namespace, volume.pool, volumeName),
        blueprintVolumeName: volume.name,
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
        metadata: {
          namespace,
          pool: volume.pool,
          volumeName,
          mountPath: volume.mount_path,
          sourceVolume: volume.type === 'clone' ? volume.source_volume : null,
          volumeType: volume.type,
        },
      })

      dynamicDevices[volume.name] = {
        type: 'disk',
        pool: volume.pool,
        source: volumeName,
        path: volume.mount_path,
        readonly: volume.readonly ? 'true' : 'false',
      }

      managedVolumes.push({
        pool: volume.pool,
        volumeName,
        mountPath: volume.mount_path,
      })
    }

    managedVolumes.sort((left, right) => right.mountPath.length - left.mountPath.length)

    const config: Record<string, string> = {
      ...blueprint.runtime.config,
      'environment.QILN_TENANT_ID': rootBranchName,
      'limits.cpu': cpu,
      'limits.memory': memory,
    }

    if (managedVolumes.length > 0) {
      const chownCommands = managedVolumes.map(volume => ['chown', '1000:1000', volume.mountPath])
      config['user.vendor-data'] = mergeCloudInit(config['user.vendor-data'], chownCommands)
    }

    const devices: IncusDeviceMap = {
      ...blueprint.runtime.devices,
      ...dynamicDevices,
    }

    return {
      project: {
        kind: 'project',
        namespace,
        resourceType: CapsuleBranchResourceType.INCUS_PROJECT,
        resourceKey: projectResourceKey(namespace),
        blueprintVolumeName: null,
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.RETAIN,
        metadata: {
          namespace,
        },
      },
      bindMounts,
      volumes,
      instance: {
        kind: 'instance',
        instanceName,
        rootfsImagePin,
        config,
        devices,
        resourceType: CapsuleBranchResourceType.INCUS_INSTANCE,
        resourceKey: instanceResourceKey(namespace, instanceName),
        blueprintVolumeName: null,
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
        metadata: {
          namespace,
          instanceName,
          rootfsImagePin,
        },
      },
      files: this.planProvisioningFiles(blueprint, {
        namespace,
        rootBranchName,
        instanceName,
        config,
        cpu,
        memory,
        managedVolumes,
      }),
      managedVolumes,
    }
  }

  private planProvisioningFiles(
    blueprint: CapsuleBlueprint,
    input: {
      namespace: string
      rootBranchName: string
      instanceName: string
      config: Record<string, string>
      cpu: string
      memory: string
      managedVolumes: ManagedVolume[]
    },
  ): CreateCapsuleProvisioningFileResource[] {
    const interpolationContext = {
      name: input.rootBranchName,
      env: input.config,
      limits: {
        cpu: input.cpu,
        memory: {
          raw: input.memory,
        },
      },
    }

    return blueprint.provisioning.files.map(file => {
      const content = file.content === undefined ? '' : interpolate(file.content, interpolationContext)
      const target = resolveFileTarget(file.path, input.managedVolumes)

      return {
        kind: 'provisioningFile',
        path: file.path,
        content,
        target,
        options: {
          uid: file.uid,
          gid: file.gid,
          mode: file.mode,
          type: file.type,
        },
        resourceType: CapsuleBranchResourceType.PROVISIONING_FILE,
        resourceKey: provisioningFileResourceKey(input.namespace, input.instanceName, file.path, target),
        blueprintVolumeName: null,
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
        metadata: createProvisioningFileResourceMetadata(
          input.namespace,
          input.rootBranchName,
          input.instanceName,
          file.path,
          target,
        ),
      }
    })
  }
}
