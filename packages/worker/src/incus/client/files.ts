import { z } from 'zod'
import { IncusError } from '../../errors'
import { buildIncusFileHeaders } from '../utils'
import { IncusFileDirectoryResponseSchema } from './schemas/storage'
import { assertFilePath } from './storage/identity'
import type { IIncusTransport, IncusFilePushOptions, IncusRawReadOptions } from './types'
import type { Response } from 'undici'

export interface IncusInstanceFileMetadata {
  uid: number
  gid: number
  mode: string
  modifiedAt: Date
}

export type IncusInstanceFileStream = NonNullable<Response['body']>

export type IncusInstanceFileEntry =
  | {
      type: 'file'
      metadata: IncusInstanceFileMetadata
      stream: IncusInstanceFileStream
      etag?: string
    }
  | {
      type: 'directory'
      metadata: IncusInstanceFileMetadata
      entries: string[]
      etag?: string
    }
  | {
      type: 'unsupported'
      providerType: string
      metadata: IncusInstanceFileMetadata
      etag?: string
    }

function readProviderHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-incus-${name}`)
}

function requireProviderHeader(response: Response, name: string, context: string): string {
  const value = readProviderHeader(response, name)
  if (value === null || value.trim() === '') {
    throw new IncusError(`Incus instance file response is missing required '${name}' metadata.`, 'VALIDATION_ERROR', {
      context,
      header: `X-Incus-${name}`,
    })
  }
  return value
}

function parseOwnerId(value: string, field: string, context: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new IncusError(`Incus instance file response contains invalid '${field}' metadata.`, 'VALIDATION_ERROR', {
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
    throw new IncusError('Incus instance file response contains an unsupported mode.', 'VALIDATION_ERROR', {
      context,
      mode: value,
    })
  }
  return normalized.padStart(4, '0')
}

function parseModifiedAt(value: string, context: string): Date {
  const modifiedAt = new Date(value)
  if (!Number.isFinite(modifiedAt.getTime())) {
    throw new IncusError(
      'Incus instance file response contains an invalid modification timestamp.',
      'VALIDATION_ERROR',
      {
        context,
        modifiedAt: value,
      },
    )
  }
  return modifiedAt
}

function parseMetadata(response: Response, context: string): IncusInstanceFileMetadata {
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

function assertCanonicalDirectoryEntryName(name: string, context: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new IncusError('Incus instance directory listing contains an unsafe entry name.', 'VALIDATION_ERROR', {
      context,
      entryName: name,
    })
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
    throw new IncusError('Failed to parse Incus instance directory listing JSON.', 'VALIDATION_ERROR', {
      path,
      error: error instanceof Error ? error.message : 'Unknown directory listing parse failure',
    })
  }
  const parsed = IncusFileDirectoryResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new IncusError(
      'Incus instance directory listing has an unsupported response envelope.',
      'VALIDATION_ERROR',
      z.treeifyError(parsed.error),
    )
  }
  for (const name of parsed.data.metadata) {
    assertCanonicalDirectoryEntryName(name, path)
  }
  return [...parsed.data.metadata].sort()
}

async function readStreamBytes(stream: IncusInstanceFileStream): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalSize = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      chunks.push(result.value)
      totalSize += result.value.byteLength
    }
  } catch (error: unknown) {
    try {
      await reader.cancel()
    } catch {
      // Preserve the original stream failure.
    }
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export class IncusFilesClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Opens one instance filesystem entry while preserving Incus-provided type,
   * ownership, mode, modification time, and optional ETag metadata.
   *
   * Unsupported provider entry types are returned explicitly after their body
   * is cancelled. Callers must never reinterpret them as regular files.
   */
  public async get(instance: string, path: string, options?: IncusRawReadOptions): Promise<IncusInstanceFileEntry> {
    assertFilePath(path)

    const queryPath = encodeURIComponent(path)
    const response = await this.transport.readRaw(
      `/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`,
      'GET',
      options,
    )
    let providerType: string
    let metadata: IncusInstanceFileMetadata
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
          instance,
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
   * Reads one regular file as bytes and returns its required Incus metadata.
   */
  public async read(
    instance: string,
    path: string,
    options?: IncusRawReadOptions,
  ): Promise<{
    data: Uint8Array
    metadata: IncusInstanceFileMetadata
    etag?: string
  }> {
    const entry = await this.get(instance, path, options)
    if (entry.type !== 'file') {
      throw new IncusError('Incus instance filesystem entry is not a regular file.', 'VALIDATION_ERROR', {
        instance,
        path,
        providerType: entry.type === 'unsupported' ? entry.providerType : entry.type,
      })
    }

    return {
      data: await readStreamBytes(entry.stream),
      metadata: entry.metadata,
      etag: entry.etag,
    }
  }

  /**
   * Pushes a file to the container disk, injecting X-Incus headers for
   * ownership.
   *
   * A malformed or ambiguous response is an uncertain provider mutation outcome
   * rather than a definite validation failure.
   */
  public async write(
    instance: string,
    path: string,
    content: Uint8Array | string,
    options: IncusFilePushOptions = {},
  ): Promise<void> {
    assertFilePath(path)

    const queryPath = encodeURIComponent(path)
    const headers = buildIncusFileHeaders(options)
    await this.transport.mutateRaw(`/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`, 'POST', {
      body: content,
      headers,
    })
  }

  /**
   * Deletes a file from the container.
   *
   * The transport validates a synchronous Incus mutation response. An
   * unreadable or malformed response is treated as an uncertain provider
   * outcome rather than a definite deletion failure.
   */
  public async delete(instance: string, path: string): Promise<void> {
    assertFilePath(path)

    const queryPath = encodeURIComponent(path)
    await this.transport.mutate(`/instances/${encodeURIComponent(instance)}/files?path=${queryPath}`, 'DELETE')
  }
}
