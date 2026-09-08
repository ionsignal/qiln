import postgres from 'postgres'

const SSH_AUTHORITY_LOCK_CLASS_ID = 1_366_970_789
const SSH_AUTHORITY_LOCK_OBJECT_ID = 1
const DEFAULT_VERIFICATION_INTERVAL_MS = 5_000
const DEFAULT_QUERY_TIMEOUT_MS = 5_000
const DATABASE_CLOSE_TIMEOUT_SECONDS = 5

type PostgresClient = ReturnType<typeof postgres>
type ReservedConnection = Awaited<ReturnType<PostgresClient['reserve']>>
type AuthorityState = 'idle' | 'acquiring' | 'held' | 'releasing' | 'released' | 'lost'

interface AcquisitionRow {
  acquired: boolean
  backendPid: number
}

interface VerificationRow {
  backendPid: number
  ownsLock: boolean
}

interface ReleaseRow {
  backendPid: number
  released: boolean
}

export interface SshAuthorityOptions {
  connectionString: string
  verificationIntervalMs?: number
  queryTimeoutMs?: number
  onFatalLoss: (error: SshAuthorityError) => void
}

export class SshAuthorityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshAuthorityError'
  }
}

function assertTimer(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${field} must be a positive integer within the supported timer range.`)
  }
}

/**
 * Enforces one SSH authority per PostgreSQL database.
 *
 * This lock uses a different key pair from Worker mutation authority. The
 * reserved physical session owns it for the runtime's entire serving lifetime.
 * Session replacement, disconnect, or unprovable ownership is fatal; the
 * authority never reconnects to reacquire its lock.
 */
export class SshAuthority {
  private readonly verificationIntervalMs: number
  private readonly queryTimeoutMs: number
  private client: PostgresClient | null = null
  private connection: ReservedConnection | null = null
  private backendPid: number | null = null
  private state: AuthorityState = 'idle'
  private timer: ReturnType<typeof setInterval> | null = null
  private verification: Promise<void> | null = null

  constructor(private readonly options: SshAuthorityOptions) {
    if (options.connectionString.trim() === '') {
      throw new SshAuthorityError('SSH authority requires a PostgreSQL connection string.')
    }
    this.verificationIntervalMs = options.verificationIntervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
    assertTimer(this.verificationIntervalMs, 'SSH authority verification interval')
    assertTimer(this.queryTimeoutMs, 'SSH authority query timeout')
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

  public async acquire(): Promise<void> {
    if (this.state === 'held') {
      return
    }
    if (this.state !== 'idle') {
      throw new SshAuthorityError('SSH authority cannot be reacquired. Create a new runtime.')
    }
    this.state = 'acquiring'
    const client = postgres(this.options.connectionString, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: null,
      connect_timeout: Math.max(1, Math.ceil(this.queryTimeoutMs / 1000)),
      onclose: () => {
        if (this.state === 'held' || this.state === 'releasing') {
          this.lose(new SshAuthorityError('The dedicated SSH authority PostgreSQL session closed.'))
        }
      },
    })
    let connection: ReservedConnection | null = null
    try {
      connection = await client.reserve()
      const rows = await this.withTimeout(connection<AcquisitionRow[]>`
        SELECT
          pg_try_advisory_lock(
            CAST(${SSH_AUTHORITY_LOCK_CLASS_ID} AS integer),
            CAST(${SSH_AUTHORITY_LOCK_OBJECT_ID} AS integer)
          ) AS "acquired",
          pg_backend_pid() AS "backendPid"
      `)
      const row = rows[0]
      if (!row || !Number.isSafeInteger(row.backendPid) || row.backendPid <= 0) {
        throw new SshAuthorityError('PostgreSQL returned invalid SSH authority acquisition evidence.')
      }
      if (row.acquired !== true) {
        throw new SshAuthorityError('Another SSH authority already holds the lock for this PostgreSQL database.')
      }
      this.client = client
      this.connection = connection
      this.backendPid = row.backendPid
      this.state = 'held'
      this.timer = setInterval(() => {
        void this.verify().catch(() => undefined)
      }, this.verificationIntervalMs)
      this.timer.unref()
    } catch (error: unknown) {
      this.state = 'released'
      try {
        connection?.release()
      } finally {
        await client.end({ timeout: DATABASE_CLOSE_TIMEOUT_SECONDS })
      }
      throw error instanceof SshAuthorityError
        ? error
        : new SshAuthorityError('Failed to acquire the SSH authority PostgreSQL session.')
    }
  }

  public async verify(): Promise<void> {
    if (this.state !== 'held') {
      throw new SshAuthorityError('SSH authority is not held.')
    }
    if (!this.verification) {
      this.verification = this.verifyOwnership()
        .catch((error: unknown) => {
          const failure =
            error instanceof SshAuthorityError
              ? error
              : new SshAuthorityError('SSH authority ownership could not be verified.')
          this.lose(failure)
          throw failure
        })
        .finally(() => {
          this.verification = null
        })
    }
    await this.verification
  }

  /**
   * Normal release is allowed only after the runtime has drained policy and
   * gateway work. Fatal loss never authorizes a replacement-session unlock.
   */
  public async release(): Promise<void> {
    if (this.state === 'idle' || this.state === 'released') {
      return
    }
    if (this.state !== 'held') {
      throw new SshAuthorityError('Normal SSH authority release is prohibited without proven ownership.')
    }
    this.stopVerification()
    await this.verify()
    const connection = this.connection
    const client = this.client
    const backendPid = this.backendPid
    if (!connection || !client || backendPid === null || !this.isHeld) {
      const failure = new SshAuthorityError('The SSH authority session is incomplete during release.')
      this.lose(failure)
      throw failure
    }
    this.state = 'releasing'
    try {
      const rows = await this.withTimeout(connection<ReleaseRow[]>`
        SELECT
          pg_backend_pid() AS "backendPid",
          pg_advisory_unlock(
            CAST(${SSH_AUTHORITY_LOCK_CLASS_ID} AS integer),
            CAST(${SSH_AUTHORITY_LOCK_OBJECT_ID} AS integer)
          ) AS "released"
      `)
      const row = rows[0]
      if (!row || row.backendPid !== backendPid || row.released !== true || this.isLost) {
        throw new SshAuthorityError('SSH authority release could not be proven on the original PostgreSQL session.')
      }
    } catch (error: unknown) {
      const failure =
        error instanceof SshAuthorityError
          ? error
          : new SshAuthorityError('SSH authority became ambiguous during release.')
      this.lose(failure)
      throw failure
    }
    this.state = 'released'
    this.connection = null
    this.client = null
    this.backendPid = null
    try {
      connection.release()
    } finally {
      await client.end({ timeout: DATABASE_CLOSE_TIMEOUT_SECONDS })
    }
  }

  private async verifyOwnership(): Promise<void> {
    const connection = this.connection
    const backendPid = this.backendPid
    if (!connection || backendPid === null) {
      throw new SshAuthorityError('SSH authority has no complete reserved PostgreSQL session.')
    }
    const rows = await this.withTimeout(connection<VerificationRow[]>`
      SELECT
        pg_backend_pid() AS "backendPid",
        EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = pg_backend_pid()
            AND classid = CAST(${SSH_AUTHORITY_LOCK_CLASS_ID} AS oid)
            AND objid = CAST(${SSH_AUTHORITY_LOCK_OBJECT_ID} AS oid)
            AND objsubid = 2
            AND mode = 'ExclusiveLock'
            AND granted = true
        ) AS "ownsLock"
    `)
    const row = rows[0]
    if (!row || row.backendPid !== backendPid || row.ownsLock !== true || this.isLost) {
      throw new SshAuthorityError('The original PostgreSQL session no longer proves exclusive SSH authority.')
    }
  }

  private lose(error: SshAuthorityError): void {
    if (this.state === 'lost' || this.state === 'released') {
      return
    }
    this.state = 'lost'
    this.stopVerification()
    this.options.onFatalLoss(error)
  }

  private stopVerification(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async withTimeout<T>(query: PromiseLike<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new SshAuthorityError('SSH authority PostgreSQL query exceeded its verification deadline.'))
      }, this.queryTimeoutMs)
    })
    try {
      return await Promise.race([query, timeout])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }
}
