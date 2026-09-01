import { request as createHttpRequest } from 'node:http'
import type {
  IncusConfigMap,
  IncusDevicesMap,
  IncusImage,
  IncusImageAlias,
  IncusInstance,
  IncusNetwork,
  IncusServer,
  IncusStoragePool,
  IncusStorageVolume,
} from './types'

const JSON_CONTENT_TYPE = 'application/json'

export interface LocalIncusClientOptions {
  socketPath: string
  requestTimeoutMs: number
  maximumResponseBytes: number
}

export class IncusTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IncusTransportError'
  }
}

export class IncusProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IncusProtocolError'
  }
}

export class IncusApiError extends Error {
  public readonly statusCode: number
  public readonly errorCode: number

  constructor(message: string, statusCode: number, errorCode: number) {
    super(message)
    this.name = 'IncusApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback
  }
  return (
    value
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1_000) || fallback
  )
}

function requiredString(record: Record<string, unknown>, key: string, entity: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new IncusProtocolError(`Incus returned an invalid ${entity}.${key} field.`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function requiredBoolean(record: Record<string, unknown>, key: string, entity: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new IncusProtocolError(`Incus returned an invalid ${entity}.${key} field.`)
  }
  return value
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return typeof value === 'boolean' ? value : false
}

function optionalNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new IncusProtocolError(`Incus returned an invalid ${field} string array.`)
  }
  return [...value]
}

function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  if (value.some(entry => typeof entry !== 'string')) {
    throw new IncusProtocolError('Incus returned an invalid string array.')
  }
  return [...value]
}

function configMap(value: unknown, field: string): IncusConfigMap {
  if (!isRecord(value)) {
    throw new IncusProtocolError(`Incus returned an invalid ${field} configuration map.`)
  }
  const result: IncusConfigMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new IncusProtocolError(`Incus returned a non-string value in ${field}.`)
    }
    result[key] = entry
  }
  return result
}

function optionalConfigMap(value: unknown): IncusConfigMap {
  if (value === undefined) {
    return {}
  }
  return configMap(value, 'optional')
}

function devicesMap(value: unknown, field: string): IncusDevicesMap {
  if (!isRecord(value)) {
    throw new IncusProtocolError(`Incus returned an invalid ${field} device map.`)
  }
  const result: IncusDevicesMap = {}
  for (const [deviceName, device] of Object.entries(value)) {
    result[deviceName] = configMap(device, `${field}.${deviceName}`)
  }
  return result
}

function optionalDevicesMap(value: unknown): IncusDevicesMap {
  if (value === undefined) {
    return {}
  }
  return devicesMap(value, 'optional')
}

function resourceRecord(value: unknown, entity: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new IncusProtocolError(`Incus returned invalid ${entity} metadata.`)
  }
  return value
}

function parseServer(value: unknown): IncusServer {
  const server = resourceRecord(value, 'server')
  const environment = resourceRecord(server.environment, 'server environment')
  return {
    apiExtensions: stringArray(server.api_extensions, 'server.api_extensions'),
    apiStatus: requiredString(server, 'api_status', 'server'),
    apiVersion: requiredString(server, 'api_version', 'server'),
    auth: requiredString(server, 'auth', 'server'),
    authUserMethod: optionalString(server, 'auth_user_method'),
    public: requiredBoolean(server, 'public', 'server'),
    environment: {
      addresses: stringArray(environment.addresses, 'server.environment.addresses'),
      architectures: stringArray(environment.architectures, 'server.environment.architectures'),
      project: optionalString(environment, 'project'),
      server: requiredString(environment, 'server', 'server.environment'),
      serverName: optionalString(environment, 'server_name'),
      serverVersion: requiredString(environment, 'server_version', 'server.environment'),
    },
  }
}

function parseStoragePool(value: unknown): IncusStoragePool {
  const pool = resourceRecord(value, 'storage pool')
  return {
    name: requiredString(pool, 'name', 'storage pool'),
    driver: requiredString(pool, 'driver', 'storage pool'),
    description: optionalString(pool, 'description'),
    status: optionalString(pool, 'status'),
    config: configMap(pool.config, 'storage pool config'),
  }
}

function parseStorageVolume(value: unknown): IncusStorageVolume {
  const volume = resourceRecord(value, 'storage volume')
  return {
    name: requiredString(volume, 'name', 'storage volume'),
    type: requiredString(volume, 'type', 'storage volume'),
    contentType: optionalString(volume, 'content_type'),
    description: optionalString(volume, 'description'),
    project: optionalString(volume, 'project'),
    location: optionalString(volume, 'location'),
    config: configMap(volume.config, 'storage volume config'),
  }
}

function parseNetwork(value: unknown): IncusNetwork {
  const network = resourceRecord(value, 'network')
  return {
    name: requiredString(network, 'name', 'network'),
    type: requiredString(network, 'type', 'network'),
    description: optionalString(network, 'description'),
    managed: requiredBoolean(network, 'managed', 'network'),
    status: optionalString(network, 'status'),
    project: optionalString(network, 'project'),
    config: configMap(network.config, 'network config'),
  }
}

function parseImageAlias(value: unknown): IncusImageAlias {
  const alias = resourceRecord(value, 'image alias')
  return {
    name: requiredString(alias, 'name', 'image alias'),
    target: requiredString(alias, 'target', 'image alias'),
    type: optionalString(alias, 'type'),
    description: optionalString(alias, 'description'),
  }
}

function parseImage(value: unknown): IncusImage {
  const image = resourceRecord(value, 'image')
  return {
    fingerprint: requiredString(image, 'fingerprint', 'image'),
    architecture: requiredString(image, 'architecture', 'image'),
    type: requiredString(image, 'type', 'image'),
    public: optionalBoolean(image, 'public'),
    cached: optionalBoolean(image, 'cached'),
    filename: optionalString(image, 'filename'),
    size: optionalNumber(image, 'size'),
    properties: optionalConfigMap(image.properties),
  }
}

function parseInstance(value: unknown): IncusInstance {
  const instance = resourceRecord(value, 'instance')
  return {
    name: requiredString(instance, 'name', 'instance'),
    architecture: requiredString(instance, 'architecture', 'instance'),
    type: requiredString(instance, 'type', 'instance'),
    status: requiredString(instance, 'status', 'instance'),
    statusCode: optionalNumber(instance, 'status_code'),
    project: optionalString(instance, 'project'),
    location: optionalString(instance, 'location'),
    profiles: optionalStringArray(instance.profiles),
    config: optionalConfigMap(instance.config),
    expandedConfig: optionalConfigMap(instance.expanded_config),
    devices: optionalDevicesMap(instance.devices),
    expandedDevices: optionalDevicesMap(instance.expanded_devices),
  }
}

function escapedPathPart(value: string): string {
  return encodeURIComponent(value)
}

export class LocalIncusClient {
  private readonly socketPath: string
  private readonly requestTimeoutMs: number
  private readonly maximumResponseBytes: number

  constructor(options: LocalIncusClientOptions) {
    if (options.socketPath.trim() === '') {
      throw new RangeError('The Incus Unix socket path cannot be empty.')
    }

    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new RangeError('The Incus request timeout must be a positive safe integer.')
    }

    if (!Number.isSafeInteger(options.maximumResponseBytes) || options.maximumResponseBytes <= 0) {
      throw new RangeError('The Incus response limit must be a positive safe integer.')
    }

    this.socketPath = options.socketPath
    this.requestTimeoutMs = options.requestTimeoutMs
    this.maximumResponseBytes = options.maximumResponseBytes
  }

  public async getServer(): Promise<IncusServer> {
    return parseServer(await this.getMetadata('/1.0'))
  }

  public async getStoragePool(name: string): Promise<IncusStoragePool> {
    return parseStoragePool(await this.getMetadata(`/1.0/storage-pools/${escapedPathPart(name)}`))
  }

  public async getStoragePoolOrNull(name: string): Promise<IncusStoragePool | null> {
    try {
      return await this.getStoragePool(name)
    } catch (error: unknown) {
      if (error instanceof IncusApiError && error.statusCode === 404) {
        return null
      }

      throw error
    }
  }

  public async getStoragePoolVolume(
    poolName: string,
    volumeType: string,
    volumeName: string,
  ): Promise<IncusStorageVolume> {
    return parseStorageVolume(
      await this.getMetadata(
        `/1.0/storage-pools/${escapedPathPart(poolName)}/volumes/${escapedPathPart(volumeType)}/${escapedPathPart(volumeName)}`,
      ),
    )
  }

  public async getStoragePoolVolumeOrNull(
    poolName: string,
    volumeType: string,
    volumeName: string,
  ): Promise<IncusStorageVolume | null> {
    try {
      return await this.getStoragePoolVolume(poolName, volumeType, volumeName)
    } catch (error: unknown) {
      if (error instanceof IncusApiError && error.statusCode === 404) {
        return null
      }

      throw error
    }
  }

  public async getNetwork(name: string): Promise<IncusNetwork> {
    return parseNetwork(await this.getMetadata(`/1.0/networks/${escapedPathPart(name)}`))
  }

  public async getNetworkOrNull(name: string): Promise<IncusNetwork | null> {
    try {
      return await this.getNetwork(name)
    } catch (error: unknown) {
      if (error instanceof IncusApiError && error.statusCode === 404) {
        return null
      }
      throw error
    }
  }

  public async getNetworks(): Promise<IncusNetwork[]> {
    const metadata = await this.getMetadata('/1.0/networks?recursion=1')
    if (!Array.isArray(metadata)) {
      throw new IncusProtocolError('Incus returned invalid network collection metadata.')
    }
    return metadata.map(parseNetwork)
  }

  public async getImageAlias(name: string): Promise<IncusImageAlias> {
    return parseImageAlias(await this.getMetadata(`/1.0/images/aliases/${escapedPathPart(name)}`))
  }

  public async getImageAliasOrNull(name: string): Promise<IncusImageAlias | null> {
    try {
      return await this.getImageAlias(name)
    } catch (error: unknown) {
      if (error instanceof IncusApiError && error.statusCode === 404) {
        return null
      }
      throw error
    }
  }

  public async getImage(fingerprint: string): Promise<IncusImage> {
    return parseImage(await this.getMetadata(`/1.0/images/${escapedPathPart(fingerprint)}`))
  }

  public async getInstance(name: string): Promise<IncusInstance> {
    return parseInstance(await this.getMetadata(`/1.0/instances/${escapedPathPart(name)}`))
  }

  public async getInstanceOrNull(name: string): Promise<IncusInstance | null> {
    try {
      return await this.getInstance(name)
    } catch (error: unknown) {
      if (error instanceof IncusApiError && error.statusCode === 404) {
        return null
      }
      throw error
    }
  }

  private async getMetadata(path: string): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false
      const rejectOnce = (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      }
      const request = createHttpRequest(
        {
          method: 'GET',
          socketPath: this.socketPath,
          path,
          agent: false,
          headers: {
            Accept: JSON_CONTENT_TYPE,
          },
        },
        response => {
          const chunks: Buffer[] = []
          let responseBytes = 0
          response.on('data', (chunk: Buffer) => {
            if (settled) {
              return
            }
            responseBytes += chunk.byteLength
            if (responseBytes > this.maximumResponseBytes) {
              response.destroy()
              rejectOnce(
                new IncusProtocolError(
                  `Incus returned a response larger than ${this.maximumResponseBytes} bytes for a bounded installer request.`,
                ),
              )
              return
            }
            chunks.push(Buffer.from(chunk))
          })
          response.once('error', error => {
            rejectOnce(new IncusTransportError('The Incus response stream failed.', { cause: error }))
          })
          response.once('end', () => {
            if (settled) {
              return
            }
            const statusCode = response.statusCode ?? 0
            const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
            if (contentType !== JSON_CONTENT_TYPE) {
              rejectOnce(
                new IncusProtocolError(`Incus returned unexpected content type '${contentType || 'missing'}'.`),
              )
              return
            }
            let envelope: unknown
            try {
              envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
            } catch (error: unknown) {
              rejectOnce(new IncusProtocolError('Incus returned invalid JSON.', { cause: error }))
              return
            }
            if (!isRecord(envelope)) {
              rejectOnce(new IncusProtocolError('Incus returned an invalid response envelope.'))
              return
            }
            const responseType = envelope.type
            const envelopeStatusCode =
              typeof envelope.status_code === 'number' && Number.isFinite(envelope.status_code)
                ? envelope.status_code
                : statusCode
            const errorCode =
              typeof envelope.error_code === 'number' && Number.isFinite(envelope.error_code)
                ? envelope.error_code
                : envelopeStatusCode
            if (statusCode < 200 || statusCode >= 300 || responseType === 'error') {
              rejectOnce(
                new IncusApiError(
                  boundedMessage(envelope.error, `Incus rejected the installer request with HTTP ${statusCode}.`),
                  statusCode,
                  errorCode,
                ),
              )
              return
            }
            if (responseType !== 'sync') {
              rejectOnce(new IncusProtocolError(`Incus returned unexpected response type '${String(responseType)}'.`))
              return
            }
            settled = true
            resolve(envelope.metadata)
          })
        },
      )
      request.setTimeout(this.requestTimeoutMs, () => {
        request.destroy(new Error('Incus request timeout'))
      })
      request.once('error', error => {
        rejectOnce(
          new IncusTransportError(`Could not query Incus through the local Unix socket ${this.socketPath}.`, {
            cause: error,
          }),
        )
      })
      request.end()
    })
  }
}
