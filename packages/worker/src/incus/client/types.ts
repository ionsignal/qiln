import type { Response } from 'undici'

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
 * Common options for project-scoped Incus requests.
 *
 * `signal` is primarily used internally to bind HTTP probes and reads to
 * transport-owned deadlines. Async operation callers should rely on the
 * transport-owned operation deadline rather than supplying an independent
 * timeout.
 */
export interface IncusRequestOptions {
  headers?: Record<string, string>
  etag?: string
  project?: string
  signal?: AbortSignal
}

/**
 * Options for JSON-encoded synchronous mutations.
 */
export interface IncusMutationOptions extends IncusRequestOptions {
  body?: unknown
}

/**
 * Options for JSON-encoded asynchronous Incus operations.
 */
export type IncusOperationOptions = IncusMutationOptions

/**
 * Options for raw streaming reads.
 *
 * Raw read options intentionally contain no body. A read response remains
 * unconsumed and is owned by the caller.
 */
export type IncusRawReadOptions = IncusRequestOptions

/**
 * Options for raw byte mutations.
 *
 * The transport consumes and validates the Incus response envelope before the
 * mutation resolves. Callers never receive the consumed response.
 */
export interface IncusRawMutationOptions extends IncusRequestOptions {
  body?: Uint8Array | string
}

export interface IIncusTransport {
  /**
   * Performs a synchronous Incus read and returns validated response metadata.
   */
  read(path: string, method: string, options?: IncusRequestOptions): Promise<{ data: unknown; etag?: string }>

  /**
   * Performs a synchronous JSON mutation.
   *
   * The mutation resolves only after a successful synchronous Incus envelope
   * has been validated. Malformed, asynchronous, unreadable, or transport-
   * ambiguous responses are classified as uncertain provider outcomes.
   */
  mutate(path: string, method: string, options?: IncusMutationOptions): Promise<void>

  /**
   * Performs a raw Incus read used by streaming file operations.
   *
   * Successful responses remain unconsumed and are owned by the caller.
   */
  readRaw(path: string, method: string, options?: IncusRawReadOptions): Promise<Response>

  /**
   * Performs a raw byte mutation used by file operations.
   *
   * The response body is consumed and validated by the transport. This method
   * deliberately returns no Response.
   */
  mutateRaw(path: string, method: string, options?: IncusRawMutationOptions): Promise<void>

  /**
   * Performs a bounded asynchronous Incus operation.
   *
   * A timeout means the provider outcome is unknown unless a terminal provider
   * state was positively observed before the deadline.
   */
  operation(path: string, method: string, options?: IncusOperationOptions): Promise<void>
}
