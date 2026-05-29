import { buildIncusFileHeaders } from '../../utils'
import type { IIncusTransport, IncusFilePushOptions } from '../types'

/**
 * Client to interact directly with offline ZFS datasets.
 */
export class IncusStorageFilesClient {
  constructor(private readonly transport: IIncusTransport) {}

  /**
   * Reads a file from a custom storage volume as raw bytes.
   */
  public async read(pool: string, volume: string, path: string): Promise<{ data: Uint8Array; etag?: string }> {
    const queryPath = encodeURIComponent(path)
    const res = await this.transport.raw(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${queryPath}`,
      'GET',
    )
    const arrayBuffer = await res.arrayBuffer()
    const etag = res.headers.get('etag') ?? undefined
    return { data: new Uint8Array(arrayBuffer), etag }
  }

  /**
   * Pushes a file directly to a custom storage volume disk, injecting X-INCUS headers for ownership.
   */
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
      { body: content, headers },
    )
  }

  /**
   * Deletes a file from a custom storage volume.
   */
  public async delete(pool: string, volume: string, path: string): Promise<void> {
    const queryPath = encodeURIComponent(path)
    await this.transport.request(
      `/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}/files?path=${queryPath}`,
      'DELETE',
    )
  }
}
