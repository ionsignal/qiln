export type IncusConfigMap = Record<string, string>
export type IncusDevicesMap = Record<string, Record<string, string>>

export interface IncusRead<T> {
  value: T
  etag: string
}

export interface IncusServerEnvironment {
  addresses: string[]
  architectures: string[]
  project: string
  server: string
  serverName: string
  serverVersion: string
}

export interface IncusServer {
  apiExtensions: string[]
  apiStatus: string
  apiVersion: string
  auth: string
  authUserMethod: string
  public: boolean
  environment: IncusServerEnvironment
}

export interface IncusStoragePool {
  name: string
  driver: string
  description: string
  status: string
  config: IncusConfigMap
}

export interface IncusStorageVolume {
  name: string
  type: string
  contentType: string
  description: string
  project: string
  location: string
  config: IncusConfigMap
}

export interface IncusStorageVolumeCreate {
  name: string
  type: string
  contentType: string
  description: string
  config: IncusConfigMap
  source: IncusConfigMap
}

export interface IncusNetwork {
  name: string
  type: string
  description: string
  managed: boolean
  status: string
  project: string
  config: IncusConfigMap
}

export interface IncusNetworkCreate {
  name: string
  type: string
  description: string
  config: IncusConfigMap
}

export interface IncusImageAlias {
  name: string
  target: string
  type: string
  description: string
}

export interface IncusImage {
  fingerprint: string
  architecture: string
  type: string
  public: boolean
  cached: boolean
  filename: string
  size: number
  properties: IncusConfigMap
}

export interface IncusInstance {
  name: string
  architecture: string
  description: string
  type: string
  status: string
  statusCode: number
  project: string
  location: string
  ephemeral: boolean
  stateful: boolean
  profiles: string[]
  config: IncusConfigMap
  expandedConfig: IncusConfigMap
  devices: IncusDevicesMap
  expandedDevices: IncusDevicesMap
}

export interface IncusInstanceCreate {
  name: string
  architecture: string
  description: string
  type: 'container'
  start: false
  ephemeral: boolean
  stateful: boolean
  profiles: string[]
  config: IncusConfigMap
  devices: IncusDevicesMap
  source: {
    type: 'image'
    fingerprint: string
  }
}

export interface IncusInstancePut {
  architecture: string
  config: IncusConfigMap
  description: string
  devices: IncusDevicesMap
  ephemeral: boolean
  profiles: string[]
  stateful: boolean
}

export interface IncusOperationRef {
  id: string
  path: string
}

export interface IncusOperation {
  id: string
  status: string
  statusCode: number
  error: string
}

export interface IncusSplitImageImport {
  fingerprint: string
  alias: string
  metadataPath: string
  metadataSize: number
  rootfsPath: string
  rootfsSize: number
}
