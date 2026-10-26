import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { request as createHttpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { InstallerError } from '../diagnostic/error'
import type { IncusConnection } from './connection'
import type {
  IncusConfigMap,
  IncusDevicesMap,
  IncusImage,
  IncusImageAlias,
  IncusInstance,
  IncusInstanceCreate,
  IncusInstancePut,
  IncusNetwork,
  IncusNetworkCreate,
  IncusOperation,
  IncusOperationRef,
  IncusRead,
  IncusServer,
  IncusSplitImageImport,
  IncusStoragePool,
  IncusStorageVolume,
  IncusStorageVolumeCreate,
} from './types'

const JSON_CONTENT_TYPE = 'application/json'
const FULL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const QUOTED_ETAG_PATTERN = /^"[a-f0-9]{64}"$/
const OPERATION_PATH_PATTERN = /^\/1\.0\/operations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export interface IncusClientOptions {
  connection: IncusConnection
  projectName: string
  requestTimeoutMs: number
  uploadTimeoutMs: number
  operationWaitTimeoutMs: number
  maximumResponseBytes: number
}

interface EnvelopeResult {
  metadata: unknown
  operation: unknown
  etag: string | undefined
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  expectedStatus: number
  expectedType: 'sync' | 'async'
  timeoutMs: number
  headers?: Readonly<Record<string, string>>
  write?: (request: ClientRequest, signal: AbortSignal) => Promise<void>
  waitOperationPath?: string
}

export class IncusTransportError extends Error {
  public readonly endpoint: string

  constructor(endpoint: string, options?: ErrorOptions) {
    super(`Could not query Incus through ${endpoint}.`, options)
    this.name = 'IncusTransportError'
    this.endpoint = endpoint
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

export class IncusOperationError extends Error {
  public readonly operationId: string
  public readonly statusCode: number

  constructor(message: string, operationId: string, statusCode: number) {
    super(message)
    this.name = 'IncusOperationError'
    this.operationId = operationId
    this.statusCode = statusCode
  }
}

export class IncusOperationWaitTimeoutError extends Error {
  public readonly operationPath: string
  public readonly timeoutMs: number

  constructor(operationPath: string, timeoutMs: number) {
    super('The Incus operation wait exceeded its local wall-clock limit.')
    this.name = 'IncusOperationWaitTimeoutError'
    this.operationPath = operationPath
    this.timeoutMs = timeoutMs
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

function requiredInteger(record: Record<string, unknown>, key: string, entity: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new IncusProtocolError(`Incus returned an invalid ${entity}.${key} field.`)
  }
  return value
}

function requiredEtag(value: string | undefined, entity: string): string {
  if (typeof value !== 'string' || !QUOTED_ETAG_PATTERN.test(value)) {
    throw new IncusProtocolError(`Incus returned an invalid ${entity} ETag.`)
  }
  return value
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new IncusProtocolError(`Incus returned an invalid ${field} string array.`)
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
    description: requiredString(pool, 'description', 'storage pool'),
    status: optionalString(pool, 'status'),
    config: configMap(pool.config, 'storage pool config'),
  }
}

function parseStorageVolume(value: unknown): IncusStorageVolume {
  const volume = resourceRecord(value, 'storage volume')
  return {
    name: requiredString(volume, 'name', 'storage volume'),
    type: requiredString(volume, 'type', 'storage volume'),
    contentType: requiredString(volume, 'content_type', 'storage volume'),
    description: requiredString(volume, 'description', 'storage volume'),
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
    description: requiredString(network, 'description', 'network'),
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

function aliasNames(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new IncusProtocolError('Incus returned an invalid image.aliases field.')
  }
  const entries: unknown[] = value
  return entries.map(entry => requiredString(resourceRecord(entry, 'image alias'), 'name', 'image alias'))
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
    aliases: aliasNames(image.aliases),
    properties: configMap(image.properties, 'image properties'),
  }
}

function parseInstance(value: unknown): IncusInstance {
  const instance = resourceRecord(value, 'instance')
  return {
    name: requiredString(instance, 'name', 'instance'),
    architecture: requiredString(instance, 'architecture', 'instance'),
    description: requiredString(instance, 'description', 'instance'),
    type: requiredString(instance, 'type', 'instance'),
    status: requiredString(instance, 'status', 'instance'),
    statusCode: requiredInteger(instance, 'status_code', 'instance'),
    project: optionalString(instance, 'project'),
    location: optionalString(instance, 'location'),
    ephemeral: requiredBoolean(instance, 'ephemeral', 'instance'),
    stateful: requiredBoolean(instance, 'stateful', 'instance'),
    profiles: stringArray(instance.profiles, 'instance.profiles'),
    config: configMap(instance.config, 'instance config'),
    expandedConfig: configMap(instance.expanded_config, 'expanded instance config'),
    devices: devicesMap(instance.devices, 'instance devices'),
    expandedDevices: devicesMap(instance.expanded_devices, 'expanded instance devices'),
  }
}

function parseOperation(value: unknown): IncusOperation {
  const operation = resourceRecord(value, 'operation')
  return {
    id: requiredString(operation, 'id', 'operation'),
    status: requiredString(operation, 'status', 'operation'),
    statusCode: requiredInteger(operation, 'status_code', 'operation'),
    error: requiredString(operation, 'err', 'operation'),
  }
}

function escapedPathPart(value: string): string {
  return encodeURIComponent(value)
}

function operationRef(value: unknown): IncusOperationRef {
  if (typeof value !== 'string') {
    throw new IncusProtocolError('Incus returned an invalid operation path.')
  }
  const match = OPERATION_PATH_PATTERN.exec(value)
  if (!match || match[1] === undefined) {
    throw new IncusProtocolError('Incus returned a non-local or malformed operation path.')
  }
  return {
    id: match[1],
    path: value,
  }
}

/**
 * Stops waiting for drain when the request fails, closes, or its lifetime is
 * aborted, so a premature closure can never leave the writer pending.
 */
async function writeChunk(request: ClientRequest, chunk: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (request.write(chunk)) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      request.off('drain', onDrain)
      request.off('error', onStop)
      request.off('close', onStop)
      signal.removeEventListener('abort', onStop)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onStop = () => {
      cleanup()
      reject(new Error('The Incus request body transfer stopped.'))
    }
    request.once('drain', onDrain)
    request.once('error', onStop)
    request.once('close', onStop)
    signal.addEventListener('abort', onStop, { once: true })
  })
}

async function writeFile(request: ClientRequest, path: string, signal: AbortSignal): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    if (typeof chunk === 'string') {
      await writeChunk(request, Buffer.from(chunk), signal)
    } else {
      await writeChunk(request, chunk, signal)
    }
  }
}

function multipartPart(boundary: string, name: string, filename: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    'utf8',
  )
}

export class IncusClient {
  private readonly connection: IncusConnection
  private readonly projectName: string
  private readonly requestTimeoutMs: number
  private readonly uploadTimeoutMs: number
  private readonly operationWaitTimeoutMs: number
  private readonly maximumResponseBytes: number

  constructor(options: IncusClientOptions) {
    if (options.projectName.trim() === '') {
      throw new RangeError('The Incus project name cannot be empty.')
    }
    for (const [name, value] of [
      ['request', options.requestTimeoutMs],
      ['upload', options.uploadTimeoutMs],
      ['operation wait', options.operationWaitTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`The Incus ${name} timeout must be a positive safe integer.`)
      }
    }
    if (!Number.isSafeInteger(options.maximumResponseBytes) || options.maximumResponseBytes <= 0) {
      throw new RangeError('The Incus response limit must be a positive safe integer.')
    }
    this.connection = options.connection
    this.projectName = options.projectName
    this.requestTimeoutMs = options.requestTimeoutMs
    this.uploadTimeoutMs = options.uploadTimeoutMs
    this.operationWaitTimeoutMs = options.operationWaitTimeoutMs
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

  public async createStoragePoolVolume(poolName: string, volume: IncusStorageVolumeCreate): Promise<void> {
    await this.json({
      method: 'POST',
      path: `/1.0/storage-pools/${escapedPathPart(poolName)}/volumes/${escapedPathPart(volume.type)}`,
      expectedStatus: 200,
      expectedType: 'sync',
      timeoutMs: this.requestTimeoutMs,
      data: {
        name: volume.name,
        type: volume.type,
        content_type: volume.contentType,
        description: volume.description,
        config: volume.config,
        source: volume.source,
      },
    })
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

  public async createNetwork(network: IncusNetworkCreate): Promise<void> {
    await this.json({
      method: 'POST',
      path: '/1.0/networks',
      expectedStatus: 201,
      expectedType: 'sync',
      timeoutMs: this.requestTimeoutMs,
      data: {
        name: network.name,
        type: network.type,
        description: network.description,
        config: network.config,
      },
    })
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

  public async getImageOrNull(fingerprint: string): Promise<IncusImage | null> {
    try {
      return await this.getImage(fingerprint)
    } catch (error: unknown) {
      if (error instanceof IncusApiError && error.statusCode === 404) {
        return null
      }
      throw error
    }
  }

  public async deleteImage(fingerprint: string): Promise<IncusOperationRef> {
    const result = await this.request({
      method: 'DELETE',
      path: `/1.0/images/${escapedPathPart(fingerprint)}`,
      expectedStatus: 202,
      expectedType: 'async',
      timeoutMs: this.requestTimeoutMs,
    })
    return operationRef(result.operation)
  }

  public async createImageAlias(name: string, fingerprint: string): Promise<void> {
    await this.json({
      method: 'POST',
      path: '/1.0/images/aliases',
      expectedStatus: 201,
      expectedType: 'sync',
      timeoutMs: this.requestTimeoutMs,
      data: {
        name,
        target: fingerprint,
        type: 'container',
        description: '',
      },
    })
  }

  public async importSplitImage(input: IncusSplitImageImport): Promise<IncusOperationRef> {
    if (!FULL_FINGERPRINT_PATTERN.test(input.fingerprint)) {
      throw new RangeError('Split-image imports require a full lowercase SHA-256 fingerprint.')
    }
    for (const size of [input.metadataSize, input.rootfsSize]) {
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw new RangeError('Split-image import sizes must be positive safe integers.')
      }
    }
    const boundary = `qiln-${randomBytes(24).toString('hex')}`
    const metadataPrefix = multipartPart(boundary, 'metadata', 'incus.tar.xz')
    const rootfsPrefix = multipartPart(boundary, 'rootfs', 'rootfs.squashfs')
    const separator = Buffer.from('\r\n', 'utf8')
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    const contentLength =
      metadataPrefix.byteLength +
      input.metadataSize +
      separator.byteLength +
      rootfsPrefix.byteLength +
      input.rootfsSize +
      closing.byteLength
    if (!Number.isSafeInteger(contentLength)) {
      throw new RangeError('The split-image multipart body is too large.')
    }
    const result = await this.request({
      method: 'POST',
      path: '/1.0/images',
      expectedStatus: 202,
      expectedType: 'async',
      timeoutMs: this.uploadTimeoutMs,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength),
        'X-Incus-fingerprint': input.fingerprint,
        'X-Incus-aliases': `alias=${input.alias}`,
      },
      write: async (request, signal) => {
        await writeChunk(request, metadataPrefix, signal)
        await writeFile(request, input.metadataPath, signal)
        await writeChunk(request, separator, signal)
        await writeChunk(request, rootfsPrefix, signal)
        await writeFile(request, input.rootfsPath, signal)
        await writeChunk(request, closing, signal)
      },
    })
    return operationRef(result.operation)
  }

  public async waitOperation(operation: IncusOperationRef): Promise<IncusOperation> {
    const validated = operationRef(operation.path)
    if (validated.id !== operation.id) {
      throw new IncusProtocolError('The Incus operation identifier does not match its local operation path.')
    }
    const result = await this.request({
      method: 'GET',
      path: `${operation.path}/wait?timeout=-1`,
      expectedStatus: 200,
      expectedType: 'sync',
      timeoutMs: this.operationWaitTimeoutMs,
      waitOperationPath: operation.path,
    })
    const completed = parseOperation(result.metadata)
    if (completed.id !== operation.id) {
      throw new IncusProtocolError('Incus returned completion metadata for a different operation.')
    }
    if (completed.statusCode !== 200 || completed.error !== '') {
      throw new IncusOperationError(
        boundedMessage(completed.error, `Incus operation ${completed.id} completed unsuccessfully.`),
        completed.id,
        completed.statusCode,
      )
    }
    return completed
  }

  public async getInstance(name: string): Promise<IncusInstance> {
    const result = await this.getInstanceWithEtag(name)
    return result.value
  }

  public async getInstanceWithEtag(name: string): Promise<IncusRead<IncusInstance>> {
    const result = await this.getEnvelope(`/1.0/instances/${escapedPathPart(name)}`)
    return {
      value: parseInstance(result.metadata),
      etag: requiredEtag(result.etag, 'instance'),
    }
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

  public async getInstanceWithEtagOrNull(name: string): Promise<IncusRead<IncusInstance> | null> {
    try {
      return await this.getInstanceWithEtag(name)
    } catch (error: unknown) {
      if (error instanceof IncusApiError && error.statusCode === 404) {
        return null
      }
      throw error
    }
  }

  public async createInstance(instance: IncusInstanceCreate): Promise<IncusOperationRef> {
    const result = await this.json({
      method: 'POST',
      path: '/1.0/instances',
      expectedStatus: 202,
      expectedType: 'async',
      timeoutMs: this.requestTimeoutMs,
      data: {
        name: instance.name,
        architecture: instance.architecture,
        description: instance.description,
        type: instance.type,
        start: instance.start,
        ephemeral: instance.ephemeral,
        stateful: instance.stateful,
        profiles: instance.profiles,
        config: instance.config,
        devices: instance.devices,
        source: instance.source,
      },
    })
    return operationRef(result.operation)
  }

  public async updateInstance(name: string, instance: IncusInstancePut, etag: string): Promise<IncusOperationRef> {
    if (!QUOTED_ETAG_PATTERN.test(etag)) {
      throw new IncusProtocolError('The guarded instance update requires an unchanged quoted Incus ETag.')
    }
    const result = await this.json({
      method: 'PUT',
      path: `/1.0/instances/${escapedPathPart(name)}`,
      expectedStatus: 202,
      expectedType: 'async',
      timeoutMs: this.requestTimeoutMs,
      headers: {
        'If-Match': etag,
      },
      data: {
        architecture: instance.architecture,
        config: instance.config,
        description: instance.description,
        devices: instance.devices,
        ephemeral: instance.ephemeral,
        profiles: instance.profiles,
        stateful: instance.stateful,
      },
    })
    return operationRef(result.operation)
  }

  private projectPath(path: string): string {
    const parsed = new URL(path, 'http://incus.local')
    if (parsed.origin !== 'http://incus.local' || !parsed.pathname.startsWith('/1.0')) {
      throw new RangeError('Incus requests must use a local versioned API path.')
    }
    if (parsed.searchParams.has('target') || parsed.searchParams.has('all-projects')) {
      throw new RangeError('Installer Incus requests must not target members or all projects.')
    }
    const project = parsed.searchParams.get('project')
    if (project !== null && project !== this.projectName) {
      throw new RangeError('Installer Incus requests cannot change projects.')
    }
    parsed.searchParams.set('project', this.projectName)
    return `${parsed.pathname}${parsed.search}`
  }

  private async getMetadata(path: string): Promise<unknown> {
    return (await this.getEnvelope(path)).metadata
  }

  private async getEnvelope(path: string): Promise<EnvelopeResult> {
    return await this.request({
      method: 'GET',
      path,
      expectedStatus: 200,
      expectedType: 'sync',
      timeoutMs: this.requestTimeoutMs,
    })
  }

  private async json(
    options: Omit<RequestOptions, 'write' | 'headers'> & {
      data: Readonly<Record<string, unknown>>
      headers?: Readonly<Record<string, string>>
    },
  ): Promise<EnvelopeResult> {
    const body = Buffer.from(JSON.stringify(options.data), 'utf8')
    return await this.request({
      ...options,
      headers: {
        'Content-Type': JSON_CONTENT_TYPE,
        'Content-Length': String(body.byteLength),
        ...options.headers,
      },
      write: (request, signal) => writeChunk(request, body, signal),
    })
  }

  /**
   * One wall-clock deadline covers opening the connection and the whole
   * exchange. The deadline aborts the request's lifetime instead of waiting for
   * a transport event, because a dead connection may never emit one.
   */
  private async request(options: RequestOptions): Promise<EnvelopeResult> {
    const path = this.projectPath(options.path)
    const lifetime = new AbortController()
    const writers: Promise<void>[] = []
    const timer = setTimeout(() => lifetime.abort(), options.timeoutMs)
    try {
      const socket = await this.connection.open(lifetime.signal)
      return await this.exchange(socket, path, options, lifetime.signal, writers)
    } catch (error: unknown) {
      throw this.failure(error, options, lifetime.signal.aborted)
    } finally {
      clearTimeout(timer)
      lifetime.abort()
      await Promise.all(writers)
    }
  }

  private failure(error: unknown, options: RequestOptions, timedOut: boolean): Error {
    if (timedOut) {
      return options.waitOperationPath === undefined
        ? new IncusTransportError(this.connection.endpoint, { cause: error })
        : new IncusOperationWaitTimeoutError(options.waitOperationPath, options.timeoutMs)
    }
    if (
      error instanceof InstallerError ||
      error instanceof IncusApiError ||
      error instanceof IncusProtocolError ||
      error instanceof IncusTransportError
    ) {
      return error
    }
    return new IncusTransportError(this.connection.endpoint, { cause: error })
  }

  private exchange(
    socket: Duplex,
    path: string,
    options: RequestOptions,
    signal: AbortSignal,
    writers: Promise<void>[],
  ): Promise<EnvelopeResult> {
    return new Promise<EnvelopeResult>((resolve, reject) => {
      const request = createHttpRequest(
        {
          method: options.method,
          path,
          createConnection: () => socket,
          headers: {
            Accept: JSON_CONTENT_TYPE,
            ...options.headers,
          },
        },
        response => this.readResponse(response, options, resolve, reject),
      )
      const fail = (error: unknown) => {
        reject(error)
        request.destroy()
        socket.destroy()
      }
      request.on('error', reject)
      socket.on('error', reject)
      signal.addEventListener('abort', () => fail(signal.reason), { once: true })
      if (options.write === undefined) {
        request.end()
        return
      }
      writers.push(
        options.write(request, signal).then(() => {
          if (!request.destroyed) {
            request.end()
          }
        }, fail),
      )
    })
  }

  private readResponse(
    response: IncomingMessage,
    options: RequestOptions,
    resolve: (result: EnvelopeResult) => void,
    reject: (error: Error) => void,
  ): void {
    const chunks: Buffer[] = []
    let responseBytes = 0
    response.on('data', (chunk: Buffer) => {
      responseBytes += chunk.byteLength
      if (responseBytes > this.maximumResponseBytes) {
        response.destroy()
        reject(
          new IncusProtocolError(
            `Incus returned a response larger than ${this.maximumResponseBytes} bytes for a bounded installer request.`,
          ),
        )
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    response.on('error', error => {
      reject(new IncusTransportError(this.connection.endpoint, { cause: error }))
    })
    response.once('close', () => {
      if (!response.complete) {
        reject(
          new IncusTransportError(this.connection.endpoint, {
            cause: new Error('The Incus response ended before it was complete.'),
          }),
        )
      }
    })
    response.once('end', () => {
      const statusCode = response.statusCode ?? 0
      const contentType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== JSON_CONTENT_TYPE) {
        reject(new IncusProtocolError(`Incus returned unexpected content type '${contentType || 'missing'}'.`))
        return
      }
      let envelope: unknown
      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      } catch (error: unknown) {
        reject(new IncusProtocolError('Incus returned invalid JSON.', { cause: error }))
        return
      }
      if (!isRecord(envelope)) {
        reject(new IncusProtocolError('Incus returned an invalid response envelope.'))
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
      if (responseType === 'error' || statusCode < 200 || statusCode >= 300) {
        reject(
          new IncusApiError(
            boundedMessage(envelope.error, `Incus rejected the installer request with HTTP ${statusCode}.`),
            statusCode,
            errorCode,
          ),
        )
        return
      }
      if (statusCode !== options.expectedStatus) {
        reject(
          new IncusProtocolError(
            `Incus returned HTTP ${statusCode}; HTTP ${options.expectedStatus} was required for this request.`,
          ),
        )
        return
      }
      if (responseType !== options.expectedType) {
        reject(
          new IncusProtocolError(
            `Incus returned response type '${String(responseType)}'; '${options.expectedType}' was required.`,
          ),
        )
        return
      }
      const rawEtag = response.headers.etag
      const etag = Array.isArray(rawEtag) ? rawEtag[0] : rawEtag
      resolve({
        metadata: envelope.metadata,
        operation: envelope.operation,
        etag,
      })
    })
  }
}
