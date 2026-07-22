import postgres from 'postgres'

const DEFAULT_LOGGER_PREFIX = '[WorkerAuthority]'
const DEFAULT_VERIFICATION_INTERVAL_MS = 5_000
const DATABASE_CLOSE_TIMEOUT_SECONDS = 5

/**
 * Two-key advisory locks are represented by `objsubid = 2` in `pg_locks`.
 *
 * These fixed positive 32-bit values identify the mutation-capable Qiln Worker
 * for the current PostgreSQL database. PostgreSQL advisory locks are scoped to
 * one database and one physical session.
 */
const MUTATION_AUTHORITY_LOCK_CLASS_ID = 1_366_970_788
const MUTATION_AUTHORITY_LOCK_OBJECT_ID = 1

type PostgresClient = ReturnType<typeof postgres>
type ReservedPostgresConnection = Awaited<ReturnType<PostgresClient['reserve']>>
type AuthorityState = 'idle' | 'acquiring' | 'held' | 'releasing' | 'released' | 'lost'

interface AuthorityAcquisitionRow {
  acquired: boolean
  backendPid: number
}

interface AuthorityVerificationRow {
  backendPid: number
  ownsLock: boolean
}

interface AuthorityReleaseRow {
  backendPid: number
  released: boolean
}

export interface WorkerAuthorityOptions {
  connectionString: string
  verificationIntervalMs?: number
  loggerPrefix?: string

  /**
   * Called once when the dedicated PostgreSQL session, backend identity, or
   * advisory-lock ownership can no longer be proven.
   *
   * The callback must initiate fail-stop handling. It must not attempt to
   * reacquire mutation authority.
   */
  onFatalLoss?: (error: AuthorityLossError) => void | Promise<void>
}

export class AuthorityAcquisitionError extends Error {
  public readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AuthorityAcquisitionError'
    this.details = details
  }
}

export class AuthorityLossError extends Error {
  public readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AuthorityLossError'
    this.details = details
  }
}

function detailsFromUnknown(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {
    value,
  }
}

function assertPositiveFiniteInterval(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('Worker authority verification interval must be a finite positive number.')
  }
}

function assertBackendPid(value: unknown, context: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AuthorityLossError(`PostgreSQL returned an invalid backend PID while ${context}.`, {
      backendPid: value,
    })
  }
}

/**
 * Owns the dedicated PostgreSQL session used to enforce one mutation-capable
 * Worker per Qiln database.
 *
 * Mutation authority belongs to the reserved physical PostgreSQL connection,
 * not to this JavaScript object. The connection is therefore retained for the
 * entire mutation-capable Worker lifetime.
 *
 * This component deliberately does not reconnect or reacquire after session
 * loss. A replacement session cannot prove that executors from the previous
 * authority session have stopped.
 */
export class WorkerAuthority {
  private readonly connectionString: string
  private readonly verificationIntervalMs: number
  private readonly loggerPrefix: string
  private readonly onFatalLoss?: WorkerAuthorityOptions['onFatalLoss']

  private client: PostgresClient | null = null
  private connection: ReservedPostgresConnection | null = null
  private backendPid: number | null = null
  private state: AuthorityState = 'idle'
  private verificationTimer: ReturnType<typeof setInterval> | null = null
  private verificationInFlight: Promise<void> | null = null
  private fatalLossReported = false

  constructor(options: WorkerAuthorityOptions) {
    if (options.connectionString.trim() === '') {
      throw new AuthorityAcquisitionError('Worker authority PostgreSQL connection string cannot be empty.')
    }
    this.connectionString = options.connectionString
    this.verificationIntervalMs = options.verificationIntervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS
    this.loggerPrefix = options.loggerPrefix ?? DEFAULT_LOGGER_PREFIX
    this.onFatalLoss = options.onFatalLoss

    assertPositiveFiniteInterval(this.verificationIntervalMs)
  }

  public get isHeld(): boolean {
    return this.state === 'held'
  }

  public get isLost(): boolean {
    return this.state === 'lost'
  }

  public get recordedBackendPid(): number | null {
    return this.backendPid
  }

  /**
   * Acquires exclusive Worker mutation authority on a reserved physical
   * PostgreSQL connection.
   *
   * A failed acquisition closes the candidate connection. No command handler or
   * provider mutation may be enabled before this method succeeds.
   */
  public async acquire(): Promise<void> {
    if (this.state === 'held') {
      return
    }
    if (this.state !== 'idle') {
      throw new AuthorityAcquisitionError(`Worker authority cannot be acquired from state '${this.state}'.`, {
        state: this.state,
      })
    }
    this.state = 'acquiring'
    const client = postgres(this.connectionString, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
    })
    let connection: ReservedPostgresConnection | null = null
    try {
      connection = await client.reserve()
      const rows = await connection<AuthorityAcquisitionRow[]>`
        SELECT
          pg_try_advisory_lock(
            CAST(${MUTATION_AUTHORITY_LOCK_CLASS_ID} AS integer),
            CAST(${MUTATION_AUTHORITY_LOCK_OBJECT_ID} AS integer)
          ) AS "acquired",
          pg_backend_pid() AS "backendPid"
      `
      const row = rows[0]
      if (!row) {
        throw new AuthorityAcquisitionError('PostgreSQL returned no result while acquiring Worker mutation authority.')
      }

      assertBackendPid(row.backendPid, 'acquiring Worker mutation authority')

      if (row.acquired !== true) {
        throw new AuthorityAcquisitionError(
          'Another mutation-capable Qiln Worker already holds authority for this database.',
          {
            backendPid: row.backendPid,
            lockClassId: MUTATION_AUTHORITY_LOCK_CLASS_ID,
            lockObjectId: MUTATION_AUTHORITY_LOCK_OBJECT_ID,
          },
        )
      }
      this.client = client
      this.connection = connection
      this.backendPid = row.backendPid
      this.state = 'held'
      this.startVerification()
      console.log(`${this.loggerPrefix} Acquired mutation authority on PostgreSQL backend ${row.backendPid}.`)
    } catch (error: unknown) {
      this.state = 'idle'
      this.backendPid = null
      await this.closeCandidateConnection(connection, client)
      if (error instanceof AuthorityAcquisitionError || error instanceof AuthorityLossError) {
        throw error
      }
      throw new AuthorityAcquisitionError('Failed to acquire the Worker mutation-authority session.', {
        error: detailsFromUnknown(error),
      })
    }
  }

  /**
   * Performs an immediate ownership check on the original reserved connection.
   *
   * This never attempts lock reacquisition. A failed check transitions the
   * authority into fatal-loss state.
   */
  public async verify(): Promise<void> {
    if (this.state !== 'held') {
      throw new AuthorityLossError(`Worker authority cannot be verified from state '${this.state}'.`, {
        state: this.state,
        recordedBackendPid: this.backendPid,
      })
    }
    try {
      await this.verifyOwnership()
    } catch (error: unknown) {
      const lossError = this.toLossError(error, 'Worker mutation-authority verification failed.')
      this.signalFatalLoss(lossError)
      throw lossError
    }
  }

  /**
   * Releases mutation authority during a proven normal shutdown.
   *
   * This method verifies the original backend and lock ownership immediately
   * before unlocking. It refuses release after a fatal ownership loss.
   */
  public async release(): Promise<void> {
    if (this.state === 'idle' || this.state === 'released') {
      return
    }
    if (this.state === 'lost') {
      throw new AuthorityLossError('Normal Worker authority release is prohibited after ownership became ambiguous.', {
        recordedBackendPid: this.backendPid,
      })
    }
    if (this.state !== 'held') {
      throw new AuthorityLossError(`Worker authority cannot be released from state '${this.state}'.`, {
        state: this.state,
        recordedBackendPid: this.backendPid,
      })
    }
    this.stopVerification()
    this.state = 'releasing'
    const inFlight = this.verificationInFlight
    if (inFlight) {
      try {
        await inFlight
      } catch {
        // Scheduled verification already reported fatal loss.
      }
    }
    if (this.isLost) {
      throw new AuthorityLossError(
        'Normal Worker authority release is prohibited because ownership was lost during shutdown verification.',
        {
          recordedBackendPid: this.backendPid,
        },
      )
    }
    const connection = this.connection
    const client = this.client
    const expectedBackendPid = this.backendPid
    if (!connection || !client || expectedBackendPid === null) {
      const lossError = new AuthorityLossError('Worker authority session is incomplete during normal release.', {
        hasConnection: connection !== null,
        hasClient: client !== null,
        recordedBackendPid: expectedBackendPid,
      })
      this.signalFatalLoss(lossError)
      throw lossError
    }
    try {
      await this.verifyOwnership()
      const rows = await connection<AuthorityReleaseRow[]>`
        SELECT
          pg_backend_pid() AS "backendPid",
          pg_advisory_unlock(
            CAST(${MUTATION_AUTHORITY_LOCK_CLASS_ID} AS integer),
            CAST(${MUTATION_AUTHORITY_LOCK_OBJECT_ID} AS integer)
          ) AS "released"
      `
      const row = rows[0]
      if (!row) {
        throw new AuthorityLossError('PostgreSQL returned no result while releasing Worker mutation authority.', {
          recordedBackendPid: expectedBackendPid,
        })
      }

      assertBackendPid(row.backendPid, 'releasing Worker mutation authority')

      if (row.backendPid !== expectedBackendPid || row.released !== true) {
        throw new AuthorityLossError(
          'Worker mutation-authority release could not be proven on the original PostgreSQL session.',
          {
            recordedBackendPid: expectedBackendPid,
            actualBackendPid: row.backendPid,
            released: row.released,
          },
        )
      }
    } catch (error: unknown) {
      const lossError = this.toLossError(error, 'Worker mutation authority became ambiguous during normal release.')
      this.signalFatalLoss(lossError)
      throw lossError
    }
    this.connection = null
    this.client = null
    this.backendPid = null
    this.state = 'released'
    try {
      connection.release()
    } finally {
      await client.end({
        timeout: DATABASE_CLOSE_TIMEOUT_SECONDS,
      })
    }
    console.log(`${this.loggerPrefix} Released mutation authority after proven normal shutdown.`)
  }

  private startVerification(): void {
    this.stopVerification()
    this.verificationTimer = setInterval(() => {
      void this.runScheduledVerification()
    }, this.verificationIntervalMs)
    this.verificationTimer.unref()
  }

  private stopVerification(): void {
    if (this.verificationTimer) {
      clearInterval(this.verificationTimer)
      this.verificationTimer = null
    }
  }

  private async runScheduledVerification(): Promise<void> {
    if (this.state !== 'held' || this.verificationInFlight) {
      return
    }
    const verification = this.verifyOwnership()
    this.verificationInFlight = verification
    try {
      await verification
    } catch (error: unknown) {
      this.signalFatalLoss(this.toLossError(error, 'Periodic Worker mutation-authority verification failed.'))
    } finally {
      if (this.verificationInFlight === verification) {
        this.verificationInFlight = null
      }
    }
  }

  private async verifyOwnership(): Promise<void> {
    const connection = this.connection
    const expectedBackendPid = this.backendPid
    if (!connection || expectedBackendPid === null) {
      throw new AuthorityLossError('Worker authority has no complete reserved PostgreSQL session.', {
        hasConnection: connection !== null,
        recordedBackendPid: expectedBackendPid,
      })
    }
    const rows = await connection<AuthorityVerificationRow[]>`
      SELECT
        pg_backend_pid() AS "backendPid",
        EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = pg_backend_pid()
            AND classid = CAST(${MUTATION_AUTHORITY_LOCK_CLASS_ID} AS oid)
            AND objid = CAST(${MUTATION_AUTHORITY_LOCK_OBJECT_ID} AS oid)
            AND objsubid = 2
            AND granted = true
        ) AS "ownsLock"
    `
    const row = rows[0]
    if (!row) {
      throw new AuthorityLossError('PostgreSQL returned no result while verifying Worker mutation authority.', {
        recordedBackendPid: expectedBackendPid,
      })
    }

    assertBackendPid(row.backendPid, 'verifying Worker mutation authority')

    if (row.backendPid !== expectedBackendPid) {
      throw new AuthorityLossError('Worker mutation-authority PostgreSQL session was replaced.', {
        recordedBackendPid: expectedBackendPid,
        actualBackendPid: row.backendPid,
      })
    }
    if (row.ownsLock !== true) {
      throw new AuthorityLossError('The dedicated Worker PostgreSQL session no longer holds mutation authority.', {
        backendPid: row.backendPid,
        lockClassId: MUTATION_AUTHORITY_LOCK_CLASS_ID,
        lockObjectId: MUTATION_AUTHORITY_LOCK_OBJECT_ID,
      })
    }
  }

  private signalFatalLoss(error: AuthorityLossError): void {
    if (this.state === 'released' || this.fatalLossReported) {
      return
    }
    this.fatalLossReported = true
    this.state = 'lost'
    this.stopVerification()
    console.error(`${this.loggerPrefix} FATAL: Exclusive Worker mutation authority can no longer be proven.`, error)
    if (!this.onFatalLoss) {
      return
    }
    try {
      const notification = this.onFatalLoss(error)
      void Promise.resolve(notification).catch((callbackError: unknown) => {
        console.error(`${this.loggerPrefix} Fatal authority-loss callback rejected.`, callbackError)
      })
    } catch (callbackError: unknown) {
      console.error(`${this.loggerPrefix} Fatal authority-loss callback threw.`, callbackError)
    }
  }

  private toLossError(error: unknown, fallbackMessage: string): AuthorityLossError {
    if (error instanceof AuthorityLossError) {
      return error
    }
    return new AuthorityLossError(fallbackMessage, {
      recordedBackendPid: this.backendPid,
      error: detailsFromUnknown(error),
    })
  }

  private async closeCandidateConnection(
    connection: ReservedPostgresConnection | null,
    client: PostgresClient,
  ): Promise<void> {
    if (connection) {
      try {
        connection.release()
      } catch (error: unknown) {
        console.warn(`${this.loggerPrefix} Failed to release a rejected authority candidate connection.`, error)
      }
    }
    try {
      await client.end({
        timeout: DATABASE_CLOSE_TIMEOUT_SECONDS,
      })
    } catch (error: unknown) {
      console.warn(`${this.loggerPrefix} Failed to close a rejected authority candidate client.`, error)
    }
  }
}
