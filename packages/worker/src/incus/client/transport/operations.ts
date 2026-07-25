import { INCUS_FINAL, IncusOperationSchema, type IncusOperation } from '../schemas/response'
import { IncusError } from '../../../errors'
import { messageFromUnknown } from './error'
import type { OperationAttempt, OperationProbe, OperationSettlement, PendingOperation } from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_PROBE_INTERVAL_MS = 2_000

export interface IncusOperationsOptions {
  timeoutMs?: number
  probeIntervalMs?: number
  probe: OperationProbe
}

/**
 * Owns the complete process-local lifecycle of submitted Incus operations.
 *
 * HTTP submission, WebSocket events, HTTP probes, reconnect reconciliation,
 * deadline expiry, and transport shutdown all converge through `settle()`. No
 * other component may resolve, reject, remove, or abort a registered pending
 * operation.
 *
 * This tracker observes only operation IDs returned by prior mutation
 * submissions. It performs no provider discovery, adoption, mutation retry, or
 * durable operation recovery.
 */
export class IncusOperations {
  private readonly timeoutMs: number
  private readonly probeIntervalMs: number
  private readonly probeOperation: OperationProbe
  private readonly pending = new Map<string, PendingOperation>()
  private readonly attempts = new Set<OperationAttempt>()

  private closed = false

  constructor(options: IncusOperationsOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
    this.probeOperation = options.probe
    this.assertPositiveInterval(this.timeoutMs, 'Incus operation timeout')
    this.assertPositiveInterval(this.probeIntervalMs, 'Incus operation probe interval')
  }

  /**
   * Starts the one overall deadline before provider mutation submission.
   */
  public begin(path: string): OperationAttempt {
    if (this.closed) {
      throw this.shutdownError()
    }
    const controller = new AbortController()
    const attempt: OperationAttempt = {
      path,
      deadlineAt: Date.now() + this.timeoutMs,
      controller,
      timer: null,
      operationId: null,
    }
    attempt.timer = setTimeout(() => {
      if (!attempt.controller.signal.aborted) {
        attempt.controller.abort()
      }
      const operationId = attempt.operationId
      if (!operationId) {
        return
      }
      const pending = this.pending.get(operationId)
      this.settle(operationId, {
        ok: false,
        error: this.deadlineError(attempt.path, operationId, pending?.lastProbeError),
      })
    }, this.timeoutMs)
    this.attempts.add(attempt)
    return attempt
  }

  /**
   * Proves an attempt remains within its deadline and the tracker is open.
   */
  public assert(attempt: OperationAttempt): void {
    if (this.closed) {
      throw this.shutdownError(attempt.operationId ?? undefined)
    }
    if (attempt.controller.signal.aborted || Date.now() >= attempt.deadlineAt) {
      throw this.deadlineError(attempt.path, attempt.operationId ?? undefined)
    }
  }

  /**
   * Registers the exact operation ID returned by an asynchronous mutation.
   *
   * Registration occurs before waiting for WebSocket events or HTTP probes.
   */
  public add(attempt: OperationAttempt, operationId: string, project?: string): Promise<void> {
    this.assert(attempt)
    if (this.pending.has(operationId)) {
      throw new IncusError(`Incus operation '${operationId}' is already pending in this transport.`, 'CONFLICT', {
        operationId,
        path: attempt.path,
      })
    }
    if (!attempt.timer) {
      throw this.deadlineError(attempt.path, operationId)
    }
    attempt.operationId = operationId
    const completion = new Promise<void>((resolve, reject) => {
      const pending: PendingOperation = {
        attempt,
        resolve,
        reject,
        probeTimer: null,
        probeInFlight: false,
        settled: false,
        ...(project === undefined ? {} : { project }),
      }
      this.pending.set(operationId, pending)
    })

    /**
     * The immediate probe recovers a terminal result whose event arrived before
     * local registration. Later probes continue independently of WebSocket
     * availability.
     */
    this.schedule(operationId, 0)

    return completion
  }

  /**
   * Applies a positively observed Incus operation state.
   *
   * Nonterminal states leave the operation pending. Malformed observations are
   * ignored rather than reinterpreted as provider failure.
   */
  public observe(value: unknown): void {
    const parsed = IncusOperationSchema.safeParse(value)
    if (!parsed.success) {
      return
    }
    this.apply(parsed.data)
  }

  /**
   * Probes every operation already registered by this process.
   *
   * Reconciliation never discovers or adopts provider operation IDs.
   */
  public async reconcile(): Promise<void> {
    const operationIds = [...this.pending.keys()]
    if (operationIds.length === 0 || this.closed) {
      return
    }
    console.log(
      `[IncusOperations] Reconciling ${operationIds.length} in-flight operation(s) after event-stream connection.`,
    )
    await Promise.allSettled(operationIds.map(operationId => this.probe(operationId)))
  }

  /**
   * Releases attempt-local timers after the public operation call settles.
   *
   * Registered operations normally clear the same timer through `settle()`.
   * Clearing it again here is harmless and covers synchronous responses and
   * submission failures.
   */
  public end(attempt: OperationAttempt): void {
    this.attempts.delete(attempt)
    if (attempt.timer) {
      clearTimeout(attempt.timer)
      attempt.timer = null
    }
  }

  /**
   * Rejects all pending or submitting operations with an uncertain shutdown
   * result.
   */
  public close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const operationId of [...this.pending.keys()]) {
      this.settle(operationId, {
        ok: false,
        error: this.shutdownError(operationId),
      })
    }
    for (const attempt of this.attempts) {
      if (!attempt.controller.signal.aborted) {
        attempt.controller.abort()
      }
      if (attempt.timer) {
        clearTimeout(attempt.timer)
        attempt.timer = null
      }
    }
    this.attempts.clear()
  }

  private apply(operation: IncusOperation): void {
    if (!INCUS_FINAL.has(operation.status_code)) {
      return
    }
    if (operation.status_code === 200) {
      this.settle(operation.id, {
        ok: true,
      })

      return
    }
    this.settle(operation.id, {
      ok: false,
      error: new IncusError(`Incus operation failed: ${operation.err ?? operation.status}`, 'API_ERROR', {
        operationId: operation.id,
        status: operation.status,
        code: operation.status_code,
        terminalProviderStateObserved: true,
        uncertainProviderOutcome: false,
      }),
    })
  }

  private schedule(operationId: string, delayMs = this.probeIntervalMs): void {
    const pending = this.pending.get(operationId)
    if (!pending || pending.settled || pending.probeTimer || this.closed) {
      return
    }
    pending.probeTimer = setTimeout(() => {
      const current = this.pending.get(operationId)

      if (!current || current !== pending || current.settled || this.closed) {
        return
      }
      current.probeTimer = null
      void this.probe(operationId)
    }, delayMs)
  }

  /**
   * Probes a known operation ID over HTTP.
   *
   * Probe failure is retained only as deadline diagnostics. It is not proof of
   * provider success, failure, or absence.
   */
  private async probe(operationId: string): Promise<void> {
    const pending = this.pending.get(operationId)
    if (!pending || pending.settled || pending.probeInFlight || this.closed) {
      return
    }
    pending.probeInFlight = true
    try {
      const data = await this.probeOperation(operationId, pending.project, pending.attempt.controller.signal)
      this.observe(data)
    } catch (error: unknown) {
      const current = this.pending.get(operationId)
      if (current === pending && !current.settled) {
        current.lastProbeError = messageFromUnknown(error)
      }
    } finally {
      const current = this.pending.get(operationId)
      if (current === pending && !current.settled) {
        current.probeInFlight = false
        this.schedule(operationId)
      }
    }
  }

  /**
   * Provides the only terminal settlement path for registered operations.
   */
  private settle(operationId: string, settlement: OperationSettlement): boolean {
    const pending = this.pending.get(operationId)
    if (!pending || pending.settled) {
      return false
    }
    pending.settled = true
    this.pending.delete(operationId)
    if (pending.attempt.timer) {
      clearTimeout(pending.attempt.timer)
      pending.attempt.timer = null
    }
    if (pending.probeTimer) {
      clearTimeout(pending.probeTimer)
      pending.probeTimer = null
    }
    if (!pending.attempt.controller.signal.aborted) {
      pending.attempt.controller.abort()
    }
    if (settlement.ok) {
      pending.resolve()
    } else {
      pending.reject(settlement.error)
    }
    return true
  }

  private deadlineError(path: string, operationId?: string, lastProbeError?: string): IncusError {
    const details: Record<string, unknown> = {
      path,
      operationId: operationId ?? null,
      timeoutMs: this.timeoutMs,
      uncertainProviderOutcome: true,
      terminalProviderStateObserved: false,
    }
    if (lastProbeError !== undefined) {
      details.lastProbeError = lastProbeError
    }
    return new IncusError(
      operationId
        ? `Incus operation '${operationId}' exceeded its overall deadline; the provider outcome is unknown.`
        : 'Incus provider mutation exceeded its overall deadline; the provider outcome is unknown.',
      'TRANSPORT_ERROR',
      details,
    )
  }

  private shutdownError(operationId?: string): IncusError {
    return new IncusError(
      'Incus client is shutting down; the provider operation outcome may be unknown.',
      'TRANSPORT_ERROR',
      {
        operationId: operationId ?? null,
        uncertainProviderOutcome: true,
        terminalProviderStateObserved: false,
        transportShutdown: true,
      },
    )
  }

  private assertPositiveInterval(value: number, context: string): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${context} must be a finite positive number.`)
    }
  }
}
