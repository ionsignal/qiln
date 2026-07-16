import type { IncusError } from '../../errors'
import type { Response } from 'undici'

/**
 * A pending asynchronous Incus operation.
 *
 * WebSocket events, HTTP probes, reconnect reconciliation, timeout expiry, and
 * transport shutdown all converge through the transport's guarded settlement
 * path. Callers must not invoke these callbacks directly.
 */
export interface PendingOp {
  resolve: () => void
  reject: (error: IncusError) => void
  deadlineAt: number
  deadlineTimer: ReturnType<typeof setTimeout>
  probeTimer: ReturnType<typeof setTimeout> | null
  probeInFlight: boolean
  settled: boolean
  abortController: AbortController
  project?: string
  lastProbeError?: string
}

/**
 * Incus file push options shared between instance and storage file clients.
 */
export interface IncusFilePushOptions {
  uid?: number
  gid?: number
  mode?: string
  type?: 'file' | 'symlink' | 'directory'
  write?: 'overwrite' | 'append'
}

/**
 * Incus instance-list filtering options.
 */
export interface IncusListOptions {
  filter?: string
}

/**
 * Request options shared by synchronous and asynchronous Incus requests.
 *
 * `signal` is primarily used internally to bind HTTP probes to the overall
 * provider-operation deadline. Operation callers should rely on the
 * transport-owned deadline rather than supplying an independent timeout.
 */
export interface IncusRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  etag?: string
  project?: string
  signal?: AbortSignal
}

/**
 * Options for raw requests that carry bytes rather than JSON.
 */
export interface IncusRawRequestOptions extends Omit<IncusRequestOptions, 'body'> {
  body?: Uint8Array | string
}

export interface IIncusTransport {
  /**
   * Performs a synchronous Incus API request.
   */
  request(path: string, method: string, options?: IncusRequestOptions): Promise<{ data: unknown; etag?: string }>

  /**
   * Performs a raw Incus API request used by file operations.
   */
  raw(path: string, method: string, options?: IncusRawRequestOptions): Promise<Response>

  /**
   * Performs a bounded asynchronous Incus operation.
   *
   * A timeout means the provider outcome is unknown unless a terminal provider
   * state was positively observed before the deadline.
   */
  operation(path: string, method: string, options?: IncusRequestOptions): Promise<void>
}
