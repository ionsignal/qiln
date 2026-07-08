import type { IncusFilePushOptions } from '../../../incus/client/types'
import type { IncusDeviceMap } from '../../../schemas/incus'
import type { ProvisioningFileTarget } from '../provisioning/fileTargets'

export interface VolumeCreateInput {
  volumeType: 'empty' | 'clone'
  pool: string
  volumeName: string
  sourceVolume: string | null
  sourceProject?: string
  config: Record<string, string>
}

export interface VolumeDeleteInput {
  pool: string
  volumeName: string
}

export interface InstanceCreateInput {
  instanceName: string
  imageAlias: string
  config: Record<string, string>
  devices: IncusDeviceMap
}

export interface ProvisioningFileWriteInput {
  path: string
  content: string
  target: ProvisioningFileTarget
  options: IncusFilePushOptions
}
