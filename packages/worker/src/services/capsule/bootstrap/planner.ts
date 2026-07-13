import { CapsuleBranchResourceCleanupPolicy, CapsuleBranchResourceType, type CapsuleBlueprint } from '@qiln/core/server'
import { interpolate } from '../../../utils/template'
import {
  bindMountResourceKey,
  branchVolumeName,
  instanceResourceKey,
  projectResourceKey,
  provisioningFileResourceKey,
  volumeResourceKey,
} from '../resources/identity'
import { createProvisioningFileResourceMetadata } from '../resources/metadata'
import { mergeCloudInit } from '../provisioning/cloudInit'
import { resolveFileTarget, type ManagedVolume } from '../provisioning/fileTargets'
import type {
  BootstrapBindMountResource,
  BootstrapProvisioningFileResource,
  BootstrapResourcePlan,
  BootstrapResourcePlanInput,
  BootstrapVolumeResource,
} from './types'
import type { IncusDeviceMap } from '../../../schemas/incus'

const SOURCE_PROJECT = 'default'

/**
 * Builds the deterministic resource plan for a capsule's first editable branch.
 */
export class BootstrapResourcePlanner {
  public createPlan(input: BootstrapResourcePlanInput): BootstrapResourcePlan {
    const { namespace, bootstrapBranchName, cpu, memory, blueprint } = input
    const dynamicDevices: IncusDeviceMap = {}
    const bindMounts: BootstrapBindMountResource[] = []
    const volumes: BootstrapVolumeResource[] = []
    const managedVolumes: ManagedVolume[] = []
    for (const volume of blueprint.provisioning.volumes) {
      const volumeName = branchVolumeName(bootstrapBranchName, volume.name)
      switch (volume.type) {
        case 'bind':
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
            cleanupPolicy: CapsuleBranchResourceCleanupPolicy.EXTERNAL,
            metadata: {
              namespace,
              hostPath: volume.host_path,
              mountPath: volume.mount_path,
              readonly: volume.readonly,
              shifted: volume.shifted,
            },
          })
          break
        case 'empty':
        case 'clone': {
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
          break
        }
      }
    }
    // Longest mount paths are matched first so nested managed volumes resolve correctly.
    managedVolumes.sort((left, right) => right.mountPath.length - left.mountPath.length)
    const config: Record<string, string> = {
      ...blueprint.instance_template.config,
      'environment.QILN_TENANT_ID': bootstrapBranchName,
      'limits.cpu': cpu,
      'limits.memory': memory,
    }
    if (managedVolumes.length > 0) {
      const chownCommands = managedVolumes.map(volume => ['chown', '1000:1000', volume.mountPath])
      config['user.vendor-data'] = mergeCloudInit(config['user.vendor-data'], chownCommands)
    }
    const devices: IncusDeviceMap = {
      ...blueprint.instance_template.devices,
      ...dynamicDevices,
    }
    const files = this.planProvisioningFiles(blueprint, {
      namespace,
      bootstrapBranchName,
      config,
      cpu,
      memory,
      managedVolumes,
    })
    // TODO: Files that resolve to the instance target cannot be written during offline bootstrap:
    // Incus file transfer supports custom volumes only. Route rootfs-targeted definitions through
    // `user.vendor-data` (supported by the current Qiln OS image and Incus) or bake them into the image.
    return {
      project: {
        kind: 'project',
        namespace,
        resourceType: CapsuleBranchResourceType.INCUS_PROJECT,
        resourceKey: projectResourceKey(namespace),
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.RETAIN,
        metadata: {
          namespace,
        },
      },
      bindMounts,
      volumes,
      instance: {
        kind: 'instance',
        instanceName: bootstrapBranchName,
        imageAlias: blueprint.image_alias,
        config,
        devices,
        resourceType: CapsuleBranchResourceType.INCUS_INSTANCE,
        resourceKey: instanceResourceKey(namespace, bootstrapBranchName),
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
        metadata: {
          namespace,
          instanceName: bootstrapBranchName,
          imageAlias: blueprint.image_alias,
        },
      },
      files,
      managedVolumes,
    }
  }

  private planProvisioningFiles(
    blueprint: CapsuleBlueprint,
    input: {
      namespace: string
      bootstrapBranchName: string
      config: Record<string, string>
      cpu: string
      memory: string
      managedVolumes: ManagedVolume[]
    },
  ): BootstrapProvisioningFileResource[] {
    const interpolationContext = {
      name: input.bootstrapBranchName,
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
        resourceKey: provisioningFileResourceKey(input.namespace, input.bootstrapBranchName, file.path, target),
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_WITH_BRANCH,
        metadata: createProvisioningFileResourceMetadata(input.namespace, input.bootstrapBranchName, file.path, target),
      }
    })
  }
}
