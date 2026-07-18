import { IncusError } from '../../../errors'
import type { IncusClient } from '../../../incus/client/index'
import type { ProjectService } from '../../project'
import type { InstanceCreateInput, ProvisioningFileWriteInput, VolumeCreateInput, VolumeDeleteInput } from './types'

export class CapsuleResourceDriver {
  constructor(
    private readonly incus: IncusClient,
    private readonly project: ProjectService,
  ) {}

  public async ensureNamespace(ownerId: string): Promise<void> {
    await this.project.ensureNamespace(ownerId)
  }

  public async createVolume(namespace: string, volume: VolumeCreateInput): Promise<void> {
    const project = this.incus.UseProject(namespace)
    if (volume.volumeType === 'clone') {
      if (!volume.sourceVolume) {
        throw new IncusError(`Clone volume '${volume.volumeName}' is missing a source volume.`, 'VALIDATION_ERROR')
      }
      await project.storage.clone(volume.pool, volume.sourceVolume, volume.volumeName, volume.config, volume.sourceProject)
      return
    }
    await project.storage.create(volume.pool, volume.volumeName, volume.config)
  }

  public async deleteVolume(namespace: string, volume: VolumeDeleteInput): Promise<void> {
    const project = this.incus.UseProject(namespace)
    await project.storage.delete(volume.pool, volume.volumeName)
  }

  public async createInstance(namespace: string, instance: InstanceCreateInput): Promise<void> {
    const project = this.incus.UseProject(namespace)
    await project.instances.create({
      name: instance.instanceName,
      source: { type: 'image', alias: instance.imageAlias },
      config: instance.config,
      devices: instance.devices,
    })
  }

  public async deleteInstance(namespace: string, instanceName: string): Promise<void> {
    const project = this.incus.UseProject(namespace)
    await project.instances.delete(instanceName)
  }

  public async writeProvisioningFile(namespace: string, branchName: string, file: ProvisioningFileWriteInput): Promise<void> {
    const project = this.incus.UseProject(namespace)
    if (file.target.target === 'volume') {
      await project.storage.files.write(file.target.pool, file.target.volumeName, file.target.internalPath, file.content, file.options)
      return
    }
    await project.files.write(branchName, file.path, file.content, file.options)
  }
}
