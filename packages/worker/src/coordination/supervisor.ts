const DEFAULT_LOGGER_PREFIX = '[OperationSupervisor]'

export interface SupervisorDrainResult {
  settled: boolean
  activeOperationIds: readonly string[]
}

export interface OperationSupervisorOptions {
  loggerPrefix?: string

  /**
   * Optional process-level diagnostic hook.
   *
   * The callback may report an executor rejection to runtime fatal-handling
   * infrastructure, but it must not retry or replace the rejected executor.
   */
  onOperationRejected?: (operationId: string, error: unknown) => void | Promise<void>
}

type DrainRaceResult = 'settled' | 'timeout'

/**
 * Tracks capsule operation executors started by one Worker process.
 *
 * This supervisor is deliberately process-local. It is not a durable queue,
 * scheduler, lease manager, retry mechanism, recovery engine, or source of
 * operation truth. PostgreSQL remains authoritative for operation state.
 */
export class OperationSupervisor {
  private readonly executions = new Map<string, Promise<void>>()
  private readonly loggerPrefix: string
  private readonly onOperationRejected?: OperationSupervisorOptions['onOperationRejected']
  private shuttingDown = false

  constructor(options: OperationSupervisorOptions = {}) {
    this.loggerPrefix = options.loggerPrefix ?? DEFAULT_LOGGER_PREFIX
    this.onOperationRejected = options.onOperationRejected
  }

  /**
   * Starts tracking one operation executor.
   *
   * The executor is invoked asynchronously after its execution has been
   * registered, ensuring synchronous executor failures pass through the
   * supervisor's rejection boundary.
   *
   * A false result means either:
   *
   * - the same operation ID is already tracked by this process; or
   * - shutdown has started and no new work may be scheduled.
   *
   * The caller must preserve the durable accepted operation in both cases. It
   * must not invoke the executor directly or create an untracked fallback task.
   */
  public schedule(operationId: string, execute: () => Promise<void>): boolean {
    if (this.shuttingDown || this.executions.has(operationId)) {
      return false
    }
    const execution = Promise.resolve().then(execute)
    this.executions.set(operationId, execution)
    void execution.then(
      () => {
        this.removeSettledExecution(operationId, execution)
      },
      (error: unknown) => {
        this.reportOperationRejection(operationId, error)
        this.removeSettledExecution(operationId, execution)
      },
    )
    return true
  }

  /**
   * Rejects all future scheduling without altering already-running executors.
   *
   * JavaScript promises cannot be forcibly cancelled. Existing executions
   * therefore remain tracked until they settle or the process terminates.
   */
  public beginShutdown(): void {
    this.shuttingDown = true
  }

  /**
   * Returns operation IDs currently tracked by this Worker process.
   *
   * The returned array is a diagnostic snapshot and is not durable execution
   * state or authority to resume an operation.
   */
  public activeOperationIds(): readonly string[] {
    return [...this.executions.keys()]
  }

  /**
   * Waits up to the supplied bound for every currently tracked executor.
   *
   * Draining begins by rejecting new scheduling, making the tracked execution
   * set stable for the duration of this call. A timeout does not cancel
   * executors and does not imply that they have stopped performing database or
   * provider calls.
   *
   * Callers must treat `settled: false` as a fatal shutdown condition and must
   * not normally release Worker mutation authority.
   */
  public async drain(timeoutMs: number): Promise<SupervisorDrainResult> {
    this.assertValidDrainTimeout(timeoutMs)
    this.beginShutdown()
    const executions = [...this.executions.values()]
    if (executions.length === 0) {
      return {
        settled: true,
        activeOperationIds: [],
      }
    }
    let handle: ReturnType<typeof setTimeout> | undefined
    const settled = Promise.allSettled(executions).then<DrainRaceResult>(() => 'settled')
    const timeout = new Promise<DrainRaceResult>(resolve => {
      handle = setTimeout(() => {
        resolve('timeout')
      }, timeoutMs)
    })
    const result = await Promise.race([settled, timeout])
    if (handle !== undefined) {
      clearTimeout(handle)
    }
    const activeOperationIds = this.activeOperationIds()
    if (result === 'settled' || activeOperationIds.length === 0) {
      return {
        settled: true,
        activeOperationIds: [],
      }
    }
    return {
      settled: false,
      activeOperationIds,
    }
  }

  private removeSettledExecution(operationId: string, settledExecution: Promise<void>): void {
    if (this.executions.get(operationId) === settledExecution) {
      this.executions.delete(operationId)
    }
  }

  private reportOperationRejection(operationId: string, error: unknown): void {
    console.error(`${this.loggerPrefix} Capsule operation executor '${operationId}' rejected.`, error)
    if (!this.onOperationRejected) {
      return
    }
    try {
      const notification = this.onOperationRejected(operationId, error)
      void Promise.resolve(notification).catch((notificationError: unknown) => {
        console.error(`${this.loggerPrefix} Operation rejection diagnostic hook failed for '${operationId}'.`, notificationError)
      })
    } catch (notificationError: unknown) {
      console.error(`${this.loggerPrefix} Operation rejection diagnostic hook threw for '${operationId}'.`, notificationError)
    }
  }

  private assertValidDrainTimeout(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('Operation supervisor drain timeout must be a finite, non-negative number.')
    }
  }
}
