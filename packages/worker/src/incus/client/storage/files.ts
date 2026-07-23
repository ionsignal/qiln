import { z } from 'zod'
import { IncusError } from '../../../errors'
import { IncusFileDirectoryListingSchema } from '../../../schemas/incus'
import { buildIncusFileHeaders } from '../../utils'
import type { IIncusTransport, IncusFilePushOptions } from '../types'
import type { Response } from 'undici'

export interface IncusStorageFileMetadata {
  uid: number
  gid: number
  mode: string
  modifiedAt: Date
}

export type IncusStorageFileEntry =
  | {
      type: 'file'
      metadata: IncusStorageFileMetadata
      data: Uint8Array
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

const INCUS_HEADER_PREFIXES = ['x-incus-', 'x-lxd-'] as const

function readProviderHeader(response: Response, name: string): string | null {
  for (const prefix of INCUS_HEADER_PREFIXES) {
    const value = response.headers.get(`${prefix}${name}`)
    if (value !== null) {
      return value
    }
  }
  return null
}

function requireProviderHeader(response: Response, name: string, context: string): string {
  const value = readProviderHeader(response, name)
  if (value === null || value.trim() === '') {
    throw new IncusError(`Incus file response is missing required '${name}' metadata.`, 'VALIDATION_ERROR', {
      context,
      header: name,
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
  const modified =
    readProviderHeader(response, 'modified') ??
    readProviderHeader(response, 'modified-at') ??
    readProviderHeader(response, 'mtime')
  if (modified === null || modified.trim() === '') {
    throw new IncusError(
      'Incus file response does not expose a modification timestamp required by the canonical artifact contract.',
      'VALIDATION_ERROR',
      {
        context,
      },
    )
  }
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

/**
 * Client to interact directly with offline custom storage volumes.
 */
export class IncusStorageFilesClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Reads a file from a custom storage volume as raw bytes.
   */
  public async read(pool: string, volume: string, path: string): Promise<{ data: Uint8Array; etag?: string }> {
    const response = await this.requestEntry(pool, volume, path)
    const providerType = requireProviderHeader(response, 'type', path)
    if (providerType !== 'file') {
      throw new IncusError('Incus storage path is not a regular file.', 'VALIDATION_ERROR', {
        path,
        providerType,
      })
    }
    const arrayBuffer = await response.arrayBuffer()
    const etag = response.headers.get('etag') ?? undefined
    return {
      data: new Uint8Array(arrayBuffer),
      etag,
    }
  }

  /**
   * Reads one path together with provider metadata.
   *
   * The files API behaves as the experimental collector's lstat-equivalent.
   * Unsupported provider entry types are returned explicitly so policy can fail
   * closed rather than infer filesystem semantics.
   */
  public async entry(pool: string, volume: string, path: string): Promise<IncusStorageFileEntry> {
    const response = await this.requestEntry(pool, volume, path)
    const providerType = requireProviderHeader(response, 'type', path)
    const metadata = parseMetadata(response, path)
    const etag = response.headers.get('etag') ?? undefined
    if (providerType === 'file') {
      const arrayBuffer = await response.arrayBuffer()
      return {
        type: 'file',
        metadata,
        data: new Uint8Array(arrayBuffer),
        etag,
      }
    }
    if (providerType === 'directory') {
      let raw: unknown
      try {
        raw = await response.json()
      } catch (error: unknown) {
        throw new IncusError('Failed to parse Incus directory listing JSON.', 'VALIDATION_ERROR', {
          path,
          error: error instanceof Error ? error.message : 'Unknown directory listing parse failure',
        })
      }
      const parsed = IncusFileDirectoryListingSchema.safeParse(raw)
      if (!parsed.success) {
        throw new IncusError(
          'Incus directory listing has an unsupported response shape.',
          'VALIDATION_ERROR',
          z.treeifyError(parsed.error),
        )
      }
      for (const name of parsed.data) {
        assertCanonicalEntryName(name, path)
      }
      return {
        type: 'directory',
        metadata,
        entries: [...parsed.data].sort(),
        etag,
      }
    }
    return {
      type: 'unsupported',
      providerType,
      metadata,
      etag,
    }
  }

  public async write(
    pool: string,
    volume: string,
    path: string,
    content: Uint8Array | string,
    options: IncusFilePushOptions = {},
  ): Promise<void> {
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
    const queryPath = encodeURIComponent(path)
    await this.transport.request(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${queryPath}`,
      'DELETE',
    )
  }

  private async requestEntry(pool: string, volume: string, path: string): Promise<Response> {
    const queryPath = encodeURIComponent(path)
    return await this.transport.raw(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${queryPath}`,
      'GET',
    )
  }
}
