import {
  CapsuleBranchResourceCleanupPolicy,
  CapsuleBranchResourceStatus,
  CapsuleBranchResourceType,
  type CapsuleBlueprint,
} from '@qiln/core/server'
import { interpolate } from '../../../../../utils/template'
import { bindMountResourceKey, branchVolumeName, instanceResourceKey, projectResourceKey, volumeResourceKey } from '../../../resources/identity'
import { mergeCloudInit } from '../../../provisioning/cloudInit'
import { resolveFileTarget, type ManagedVolume } from '../../../provisioning/fileTargets'
import type {
  CapsuleBranchCreatePlanInput,
  CapsuleBranchCreateResourcePlan,
  PlannedBindMountResource,
  PlannedProvisioningFile,
  PlannedVolumeResource,
} from './types'
import type { IncusDeviceMap } from '../../../../../schemas/incus'

const SOURCE_PROJECT = 'default'

export class CapsuleBranchCreatePlanner {
  public createPlan(input: CapsuleBranchCreatePlanInput): CapsuleBranchCreateResourcePlan {
    const { namespace, name, cpu, memory, blueprint } = input
    const dynamicDevices: IncusDeviceMap = {}
    const bindMounts: PlannedBindMountResource[] = []
    const volumes: PlannedVolumeResource[] = []
    const managedVolumes: ManagedVolume[] = []
    for (const volume of blueprint.provisioning.volumes) {
      const volumeName = branchVolumeName(name, volume.name)
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
            status: CapsuleBranchResourceStatus.CREATED,
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
            cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_ON_ROLLBACK,
            status: CapsuleBranchResourceStatus.CREATING,
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
    managedVolumes.sort((a, b) => b.mountPath.length - a.mountPath.length)
    const env: Record<string, string> = {
      ...blueprint.instance_template.config,
      'environment.QILN_TENANT_ID': name,
      'limits.cpu': cpu,
      'limits.memory': memory,
    }
    if (managedVolumes.length > 0) {
      const chownCommands = managedVolumes.map(volume => ['chown', '1000:1000', volume.mountPath])
      env['user.vendor-data'] = mergeCloudInit(env['user.vendor-data'], chownCommands)
    }
    const devices: IncusDeviceMap = {
      ...blueprint.instance_template.devices,
      ...dynamicDevices,
    }
    const files = this.planProvisioningFiles(blueprint, {
      name,
      env,
      cpu,
      memory,
      managedVolumes,
    })
    return {
      project: {
        kind: 'project',
        namespace,
        resourceType: CapsuleBranchResourceType.INCUS_PROJECT,
        resourceKey: projectResourceKey(namespace),
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.RETAIN,
        status: CapsuleBranchResourceStatus.CREATING,
        metadata: {
          namespace,
        },
      },
      bindMounts,
      volumes,
      instance: {
        kind: 'instance',
        instanceName: name,
        imageAlias: blueprint.image_alias,
        config: env,
        devices,
        resourceType: CapsuleBranchResourceType.INCUS_INSTANCE,
        resourceKey: instanceResourceKey(namespace, name),
        cleanupPolicy: CapsuleBranchResourceCleanupPolicy.DELETE_ON_ROLLBACK,
        status: CapsuleBranchResourceStatus.CREATING,
        metadata: {
          namespace,
          instanceName: name,
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
      name: string
      env: Record<string, string>
      cpu: string
      memory: string
      managedVolumes: ManagedVolume[]
    },
  ): PlannedProvisioningFile[] {
    const interpolationContext = {
      name: input.name,
      env: input.env,
      limits: {
        cpu: input.cpu,
        memory: {
          raw: input.memory,
        },
      },
    }
    return blueprint.provisioning.files.map(file => {
      const content = file.content === undefined ? '' : interpolate(file.content, interpolationContext)
      return {
        path: file.path,
        content,
        target: resolveFileTarget(file.path, input.managedVolumes),
        options: {
          uid: file.uid,
          gid: file.gid,
          mode: file.mode,
          type: file.type,
        },
      }
    })
  }
}
