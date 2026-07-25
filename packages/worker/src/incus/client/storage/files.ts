import { z } from 'zod'
import { IncusError } from '../../../errors'
import { IncusFileDirectoryResponseSchema } from '../schemas/storage'
import { buildIncusFileHeaders } from '../../utils'
import type { IIncusTransport, IncusFilePushOptions } from '../types'
import type { Response } from 'undici'

export interface IncusStorageFileMetadata {
  uid: number
  gid: number
  mode: string
  modifiedAt: Date
}

export type IncusStorageFileStream = NonNullable<Response['body']>

export type IncusStorageReadEntry =
  | {
      type: 'file'
      metadata: IncusStorageFileMetadata
      stream: IncusStorageFileStream
      etag?: string
    }
  | {
      type: 'directory'
      metadata: IncusStorageFileMetadata
      entries: string[]
      etag?: string
    }
  | {
      type: 'unsupported'
      providerType: string
      metadata: IncusStorageFileMetadata
      etag?: string
    }

export interface IncusStorageReadOptions {
  signal?: AbortSignal
}

interface IncusStorageSnapshotIdentity {
  pool: string
  sourceVolume: string
  snapshotName: string
  qualifiedVolume: string
}

function readProviderHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-incus-${name}`)
}

function requireProviderHeader(response: Response, name: string, context: string): string {
  const value = readProviderHeader(response, name)
  if (value === null || value.trim() === '') {
    throw new IncusError(`Incus file response is missing required '${name}' metadata.`, 'VALIDATION_ERROR', {
      context,
      header: `X-Incus-${name}`,
    })
  }
  return value
}

function parseOwnerId(value: string, field: string, context: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new IncusError(`Incus file response contains invalid '${field}' metadata.`, 'VALIDATION_ERROR', {
      context,
      field,
      value,
    })
  }
  return parsed
}

function parseMode(value: string, context: string): string {
  const normalized = value.trim().replace(/^0o/, '')
  if (!/^[0-7]{3,4}$/.test(normalized)) {
    throw new IncusError('Incus file response contains an unsupported mode.', 'VALIDATION_ERROR', {
      context,
      mode: value,
    })
  }
  return normalized.padStart(4, '0')
}

function parseModifiedAt(value: string, context: string): Date {
  const modifiedAt = new Date(value)
  if (!Number.isFinite(modifiedAt.getTime())) {
    throw new IncusError('Incus file response contains an invalid modification timestamp.', 'VALIDATION_ERROR', {
      context,
      modifiedAt: value,
    })
  }
  return modifiedAt
}

function parseMetadata(response: Response, context: string): IncusStorageFileMetadata {
  const uid = requireProviderHeader(response, 'uid', context)
  const gid = requireProviderHeader(response, 'gid', context)
  const mode = requireProviderHeader(response, 'mode', context)
  const modified = requireProviderHeader(response, 'modified', context)
  return {
    uid: parseOwnerId(uid, 'uid', context),
    gid: parseOwnerId(gid, 'gid', context),
    mode: parseMode(mode, context),
    modifiedAt: parseModifiedAt(modified, context),
  }
}

function assertCanonicalEntryName(name: string, context: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0') ||
    name.includes('\\')
  ) {
    throw new IncusError('Incus directory listing contains an unsafe entry name.', 'VALIDATION_ERROR', {
      context,
      entryName: name,
    })
  }
}

function assertStoragePath(value: string): void {
  if (value === '/') {
    return
  }
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('\0')) {
    throw new IncusError('Incus storage file path must be a canonical absolute POSIX path.', 'VALIDATION_ERROR', {
      path: value,
    })
  }
  const segments = value.slice(1).split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new IncusError('Incus storage file path must be a canonical absolute POSIX path.', 'VALIDATION_ERROR', {
      path: value,
    })
  }
}

function assertProviderIdentity(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 255 ||
    value.includes('/') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new IncusError(`Incus snapshot ${field} is invalid.`, 'VALIDATION_ERROR', {
      field,
      value,
    })
  }
}

function createSnapshotIdentity(
  pool: string,
  sourceVolume: string,
  snapshotName: string,
): IncusStorageSnapshotIdentity {
  assertProviderIdentity(pool, 'pool')
  assertProviderIdentity(sourceVolume, 'source volume')
  assertProviderIdentity(snapshotName, 'name')
  const qualifiedVolume = `${sourceVolume}/${snapshotName}`
  if (qualifiedVolume.length > 511) {
    throw new IncusError('Qualified Incus snapshot volume identity is too long.', 'VALIDATION_ERROR', {
      sourceVolume,
      snapshotName,
      length: qualifiedVolume.length,
    })
  }
  return {
    pool,
    sourceVolume,
    snapshotName,
    qualifiedVolume,
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body
  if (!body || body.locked) {
    return
  }
  try {
    await body.cancel()
  } catch {
    // The response may already be closing after a transport or parse failure.
  }
}

async function parseDirectory(response: Response, path: string): Promise<string[]> {
  let raw: unknown
  try {
    raw = await response.json()
  } catch (error: unknown) {
    throw new IncusError('Failed to parse Incus directory listing JSON.', 'VALIDATION_ERROR', {
      path,
      error: error instanceof Error ? error.message : 'Unknown directory listing parse failure',
    })
  }
  const parsed = IncusFileDirectoryResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new IncusError(
      'Incus directory listing has an unsupported response envelope.',
      'VALIDATION_ERROR',
      z.treeifyError(parsed.error),
    )
  }
  for (const name of parsed.data.metadata) {
    assertCanonicalEntryName(name, path)
  }
  return [...parsed.data.metadata].sort()
}

async function requestEntry(
  transport: IIncusTransport,
  pool: string,
  volume: string,
  path: string,
  options: IncusStorageReadOptions = {},
): Promise<Response> {
  assertStoragePath(path)
  const queryPath = encodeURIComponent(path)
  const requestOptions = options.signal === undefined ? undefined : { signal: options.signal }
  return await transport.raw(
    `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${queryPath}`,
    'GET',
    requestOptions,
  )
}

async function openEntry(
  transport: IIncusTransport,
  pool: string,
  volume: string,
  path: string,
  options: IncusStorageReadOptions = {},
): Promise<IncusStorageReadEntry> {
  const response = await requestEntry(transport, pool, volume, path, options)
  let providerType: string
  let metadata: IncusStorageFileMetadata
  try {
    providerType = requireProviderHeader(response, 'type', path)
    metadata = parseMetadata(response, path)
  } catch (error: unknown) {
    await cancelResponseBody(response)
    throw error
  }
  const etag = response.headers.get('etag') ?? undefined
  if (providerType === 'file') {
    if (!response.body) {
      throw new IncusError('Incus regular-file response has no readable body.', 'VALIDATION_ERROR', {
        pool,
        volume,
        path,
      })
    }
    return {
      type: 'file',
      metadata,
      stream: response.body,
      etag,
    }
  }
  if (providerType === 'directory') {
    return {
      type: 'directory',
      metadata,
      entries: await parseDirectory(response, path),
      etag,
    }
  }
  await cancelResponseBody(response)
  return {
    type: 'unsupported',
    providerType,
    metadata,
    etag,
  }
}

/**
 * Read-only Files API handle for one exact retained custom-volume snapshot.
 *
 * The provider identity is supplied as separate validated components and
 * qualified internally. The handle exposes no write, delete, listing, provider
 * discovery, or adoption capability.
 */
export class IncusStorageSnapshotFilesClient {
  private readonly identityValue: IncusStorageSnapshotIdentity

  constructor(
    private readonly transport: IIncusTransport,
    pool: string,
    sourceVolume: string,
    snapshotName: string,
  ) {
    this.identityValue = createSnapshotIdentity(pool, sourceVolume, snapshotName)
  }

  public get identity(): Readonly<IncusStorageSnapshotIdentity> {
    return this.identityValue
  }

  /**
   * Opens one snapshot-backed path.
   *
   * Regular files remain stream-backed. The caller owns stream consumption and
   * must cancel the stream if it exits before reaching EOF.
   */
  public async get(path: string, options: IncusStorageReadOptions = {}): Promise<IncusStorageReadEntry> {
    return await openEntry(this.transport, this.identityValue.pool, this.identityValue.qualifiedVolume, path, options)
  }
}

/**
 * Client for mutable custom storage-volume files and construction of read-only,
 * exact-identity snapshot handles.
 */
export class IncusStorageFilesClient {
  constructor(private readonly transport: IIncusTransport) {}

  public snapshot(pool: string, sourceVolume: string, snapshotName: string): IncusStorageSnapshotFilesClient {
    return new IncusStorageSnapshotFilesClient(this.transport, pool, sourceVolume, snapshotName)
  }

  public async write(
    pool: string,
    volume: string,
    path: string,
    content: Uint8Array | string,
    options: IncusFilePushOptions = {},
  ): Promise<void> {
    assertStoragePath(path)
    const queryPath = encodeURIComponent(path)
    const headers = buildIncusFileHeaders(options)
    await this.transport.raw(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${queryPath}`,
      'POST',
      {
        body: content,
        headers,
      },
    )
  }

  public async delete(pool: string, volume: string, path: string): Promise<void> {
    assertStoragePath(path)
    const queryPath = encodeURIComponent(path)
    await this.transport.request(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${queryPath}`,
      'DELETE',
    )
  }
}
