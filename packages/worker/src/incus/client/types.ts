import type { IncusError } from '../../errors'
import type { Response } from 'undici'

// A pending async Incus operation awaiting resolution via the event stream.
export interface PendingOp {
  resolve: () => void
  reject: (e: IncusError) => void
  timer: NodeJS.Timeout
  project?: string
}

// IncusFilePushOptions shared between Instance and Storage file clients
export interface IncusFilePushOptions {
  uid?: number
  gid?: number
  mode?: string // e.g., '0600'
  type?: 'file' | 'symlink' | 'directory'
  write?: 'overwrite' | 'append'
}

// IncusListOptions for filtering and scoping instance list requests
export interface IncusListOptions {
  filter?: string
}

// Options interface to support ETag and Headers
export interface IncusRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  etag?: string
  project?: string
}

// Options for raw requests to enforce type safety
export interface IncusRawRequestOptions extends Omit<IncusRequestOptions, 'body'> {
  body?: Uint8Array | string
}

export interface IIncusTransport {
  /**
   * Internal wrapper for synchronous Incus requests.
   */
  request(path: string, method: string, options?: IncusRequestOptions): Promise<{ data: unknown; etag?: string }>

  /**
   * Internal wrapper for requestRaw used in Incus File API requests that deal in raw bytes rather than JSON
   */
  raw(path: string, method: string, options?: IncusRawRequestOptions): Promise<Response>

  /**
   * Internal wrapper for asynchronous Incus requests.
   * Resolves via the WebSocket event stream rather than HTTP long-polling.
   */
  operation(path: string, method: string, options?: IncusRequestOptions): Promise<void>
}
