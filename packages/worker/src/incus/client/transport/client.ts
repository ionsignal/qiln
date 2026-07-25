import { IncusError } from '../../../errors'
import { IncusEvents } from './events'
import { IncusHttp, resolveIncusEndpoints } from './http'
import { IncusOperations } from './operations'
import {
  data as responseData,
  isObservedTerminalProviderFailure,
  operation as responseOperation,
  parseIncusResponse,
  readError,
} from './response'
import { detailsFromUnknown } from './error'
import type { WorkerIncusConfig } from '../../../types'
import type {
  IIncusTransport,
  IncusMutationOptions,
  IncusOperationOptions,
  IncusRawMutationOptions,
  IncusRawReadOptions,
  IncusRequestOptions,
} from '../types'
import type { OperationAttempt } from './types'
import type { Response } from 'undici'

/**
 * Shared Incus transport façade.
 *
 * Focused internal components own:
 *
 * - HTTP endpoint, agent, headers, and dispatch;
 * - Incus response parsing and provider-outcome classification;
 * - Async operation deadlines, probes, and one-time settlement;
 * - WebSocket connection and reconnect lifecycle.
 *
 * Reads and mutations use distinct public methods. Synchronous mutations
 * resolve only after a successful Incus response envelope has been consumed and
 * validated. Raw reads remain stream-backed and transfer response ownership to
 * the caller.
 *
 * WebSocket readiness is never required for provider-operation progress. Once
 * an async operation ID is returned, HTTP probing and WebSocket observation
 * independently converge through the operation tracker's settlement boundary.
 */
export class IncusTransport implements IIncusTransport {
  private readonly http: IncusHttp
  private readonly operations: IncusOperations
  private readonly events: IncusEvents

  private closed = false

  constructor(config: WorkerIncusConfig = {}) {
    const endpoints = resolveIncusEndpoints(config)
    this.http = new IncusHttp(config, endpoints)
    this.operations = new IncusOperations({
      probe: async (operationId, project, signal) => {
        const { data } = await this.readInternal(
          `/operations/${encodeURIComponent(operationId)}`,
          'GET',
          project === undefined
            ? {
                signal,
              }
            : {
                project,
                signal,
              },
        )

        return data
      },
    })
    this.events = new IncusEvents({
      config,
      endpoints,
      observe: operation => {
        this.operations.observe(operation)
      },
      reconcile: async () => {
        await this.operations.reconcile()
      },
    })
  }

  /**
   * Performs local HTTP preflight and starts the operation event stream.
   */
  public async init(): Promise<void> {
    this.assertOpen()
    this.http.init()
    this.events.start()
  }

  /**
   * Closes provider connectivity and rejects every submitting or registered
   * async operation as an uncertain provider outcome.
   */
  public destroy(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.events.stop()
    this.operations.close()
    this.http.close()
  }

  /**
   * Performs a synchronous Incus read and validates the universal response
   * envelope.
   */
  public async read(
    path: string,
    method: string,
    options?: IncusRequestOptions,
  ): Promise<{ data: unknown; etag?: string }> {
    this.assertOpen()
    return await this.readInternal(path, method, options)
  }

  /**
   * Performs a synchronous JSON mutation.
   *
   * A successful mutation must return a valid synchronous Incus envelope.
   * Malformed, asynchronous, non-successful, or transport-ambiguous responses
   * become uncertain provider outcomes unless Incus positively supplied a
   * terminal error envelope.
   */
  public async mutate(path: string, method: string, options?: IncusMutationOptions): Promise<void> {
    this.assertOpen()
    await this.mutateInternal(path, method, async () => {
      return await this.http.json(path, method, options)
    })
  }

  /**
   * Performs a raw Incus read for Files API operations.
   *
   * Successful responses remain stream-backed and are owned by the caller.
   */
  public async readRaw(path: string, method: string, options?: IncusRawReadOptions): Promise<Response> {
    this.assertOpen()
    const response = await this.http.raw(path, method, options)
    if (response.ok) {
      return response
    }
    throw await readError(response, path, method)
  }

  /**
   * Performs a raw Incus mutation for Files API operations.
   *
   * The response is consumed and validated before this method resolves. A
   * caller cannot receive an already-consumed Response.
   */
  public async mutateRaw(path: string, method: string, options?: IncusRawMutationOptions): Promise<void> {
    this.assertOpen()
    await this.mutateInternal(path, method, async () => {
      return await this.http.raw(path, method, options)
    })
  }

  /**
   * Performs one bounded asynchronous Incus mutation.
   *
   * The overall deadline begins before HTTP submission. No provider mutation is
   * retried, and only the exact operation ID returned by Incus may be tracked
   * or probed.
   *
   * Positively observed terminal provider failures take precedence over an
   * attempt deadline reached while receiving or parsing that response. A
   * deadline cannot erase stronger terminal evidence already supplied by
   * Incus.
   */
  public async operation(path: string, method: string, options?: IncusOperationOptions): Promise<void> {
    this.assertOpen()
    const attempt = this.operations.begin(path)
    try {
      let response: Response
      try {
        response = await this.http.json(path, method, {
          ...options,
          signal: attempt.controller.signal,
        })
      } catch (error: unknown) {
        throw this.mutationError(path, method, error, attempt)
      }
      let parsed: Awaited<ReturnType<typeof parseIncusResponse>>
      try {
        parsed = await parseIncusResponse(response, {
          path,
          method,
          mutation: true,
        })
      } catch (error: unknown) {
        throw this.mutationError(path, method, error, attempt)
      }
      let result: ReturnType<typeof responseOperation>
      try {
        /**
         * Interpret a valid Incus error envelope before applying deadline
         * uncertainty. Positively observed terminal failure is stronger
         * evidence than local timer state.
         */
        result = responseOperation(parsed, {
          path,
          method,
        })
      } catch (error: unknown) {
        throw this.mutationError(path, method, error, attempt)
      }
      this.operations.assert(attempt)
      if (result.kind === 'sync') {
        return
      }
      await this.operations.add(attempt, result.operationId, options?.project)
    } finally {
      this.operations.end(attempt)
    }
  }

  private async readInternal(
    path: string,
    method: string,
    options?: IncusRequestOptions,
  ): Promise<{ data: unknown; etag?: string }> {
    const response = await this.http.json(path, method, options)
    const parsed = await parseIncusResponse(response, {
      path,
      method,
    })
    return responseData(parsed, {
      path,
      method,
    })
  }

  /**
   * Central synchronous mutation boundary shared by JSON and raw byte
   * mutations.
   *
   * The submitted response is always interpreted with mutation context. This
   * prevents malformed or non-Incus responses from being mistaken for definite
   * provider rejection and prevents async envelopes from escaping a synchronous
   * mutation API.
   */
  private async mutateInternal(path: string, method: string, submit: () => Promise<Response>): Promise<void> {
    try {
      const response = await submit()
      const parsed = await parseIncusResponse(response, {
        path,
        method,
        mutation: true,
      })
      responseData(parsed, {
        path,
        method,
        mutation: true,
      })
    } catch (error: unknown) {
      throw this.mutationError(path, method, error)
    }
  }

  /**
   * Preserves only positively observed terminal provider failures.
   *
   * Every other mutation error is normalized to transport uncertainty,
   * including malformed envelopes, unreadable responses, unexpected HTTP
   * statuses, unsupported asynchronous synchronous-mutation responses, request
   * transport failures, and expired async attempts.
   *
   * Terminal provider evidence is checked before attempt expiry so a deadline
   * cannot erase a valid terminal Incus error response.
   */
  private mutationError(path: string, method: string, error: unknown, attempt?: OperationAttempt): IncusError {
    if (isObservedTerminalProviderFailure(error)) {
      return error
    }
    if (attempt && (attempt.controller.signal.aborted || Date.now() >= attempt.deadlineAt)) {
      this.operations.assert(attempt)
    }
    const details: Record<string, unknown> = {
      path,
      method,
      operationId: attempt?.operationId ?? null,
      uncertainProviderOutcome: true,
      terminalProviderStateObserved: false,
      error: this.errorDetails(error),
    }
    if (error instanceof IncusError && error.details !== undefined) {
      details.responseDetails = error.details
    }
    return new IncusError(
      error instanceof Error && error.message
        ? `Incus provider mutation outcome is uncertain: ${error.message}`
        : 'Incus provider mutation outcome is uncertain.',
      'TRANSPORT_ERROR',
      details,
    )
  }

  private errorDetails(error: unknown): Record<string, unknown> {
    if (error instanceof IncusError) {
      const details: Record<string, unknown> = {
        name: error.name,
        message: error.message,
        code: error.code,
      }
      if (error.details !== undefined) {
        details.details = error.details
      }
      return details
    }
    return detailsFromUnknown(error)
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new IncusError('Incus client is closed.', 'TRANSPORT_ERROR', {
        transportShutdown: true,
      })
    }
  }
}
