import type { CapsuleRootfsImagePin } from '@qiln/core/server'
import type { IncusDeviceMap } from '../../../incus/client'
import type { IncusFilePushOptions } from '../../../incus/client/types'
import type { ProvisioningFileTarget } from './bootstrap/targets'

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
  rootfsImagePin: CapsuleRootfsImagePin
  config: Record<string, string>
  devices: IncusDeviceMap
}

export interface ProvisioningFileWriteInput {
  path: string
  content: string
  target: ProvisioningFileTarget
  options: IncusFilePushOptions
}
