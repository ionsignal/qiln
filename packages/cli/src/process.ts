import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_PROCESS_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface ProcessOptions {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

export type ProcessFailureKind = 'start' | 'timeout' | 'output'

export interface ProcessExecutionErrorOptions {
  kind: ProcessFailureKind
  command: string
}

export class ProcessExecutionError extends Error {
  public readonly kind: ProcessFailureKind
  public readonly command: string

  constructor(message: string, options: ProcessExecutionErrorOptions) {
    super(message)
    this.name = 'ProcessExecutionError'
    this.kind = options.kind
    this.command = options.command
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || DEFAULT_PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export async function findExecutable(command: string): Promise<string | null> {
  if (command === '' || command.includes('/') || command.includes('\0')) {
    throw new RangeError('Executable names must be non-empty base names.')
  }
  const pathValue = process.env.PATH || DEFAULT_PATH
  for (const pathEntry of pathValue.split(delimiter)) {
    if (pathEntry === '' || !isAbsolute(pathEntry)) {
      continue
    }
    const candidate = join(pathEntry, command)
    try {
      const executable = await realpath(candidate)
      if (!(await stat(executable)).isFile()) {
        continue
      }
      await access(executable, constants.X_OK)
      return executable
    } catch {
      continue
    }
  }
  return null
}

export async function runProcess(
  executable: string,
  argumentsList: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  if (!isAbsolute(executable)) {
    throw new RangeError('Processes must be started through an absolute executable path.')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Process timeout must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('Process output limit must be a positive safe integer.')
  }
  const command = basename(executable) || 'local command'
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, [...argumentsList], {
      cwd: options.cwd,
      env: sanitizedEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let outputLimitExceeded = false
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const appendChunk = (chunks: Buffer[], chunk: Buffer) => {
      if (outputLimitExceeded) {
        return
      }
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    child.stdout.on('data', (chunk: Buffer) => {
      appendChunk(stdoutChunks, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      appendChunk(stderrChunks, chunk)
    })
    child.once('error', () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(
        new ProcessExecutionError(`Could not start the required local '${command}' command.`, {
          kind: 'start',
          command,
        }),
      )
    })
    child.once('close', (exitCode, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (timedOut) {
        reject(
          new ProcessExecutionError(`The required local '${command}' command exceeded its ${timeoutMs}ms timeout.`, {
            kind: 'timeout',
            command,
          }),
        )
        return
      }
      if (outputLimitExceeded) {
        reject(
          new ProcessExecutionError(
            `The required local '${command}' command exceeded its ${maxOutputBytes}-byte output limit.`,
            {
              kind: 'output',
              command,
            },
          ),
        )
        return
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
  })
}

export type SetupFailureKind = 'start' | 'cancelled' | 'timeout' | 'output' | 'exit' | 'lifecycle'

export interface SetupOptions extends ProcessOptions {
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export class SetupExecutionError extends Error {
  constructor(
    public readonly kind: SetupFailureKind,
    public readonly command: string,
    public readonly terminationConfirmed: boolean,
    public readonly exitCode: number | null,
  ) {
    super(`The owned setup process '${command}' did not complete successfully.`)
    this.name = 'SetupExecutionError'
  }
}

const SETUP_TERM_GRACE_MS = 2_000
const SETUP_KILL_GRACE_MS = 2_000
const SETUP_POLL_MS = 50

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds)
  })
}

function groupGone(pid: number | undefined): boolean {
  if (pid === undefined) {
    return true
  }
  try {
    process.kill(-pid, 0)
    return false
  } catch (error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // Confirmation comes from subsequent observation, not signal delivery.
  }
}

/**
 * Owns a Unix setup group, not arbitrary descendants that escape that group or
 * work delegated to operating-system services.
 */
export async function runSetup(
  executable: string,
  argumentsList: readonly string[],
  options: SetupOptions,
): Promise<ProcessResult> {
  if (!isAbsolute(executable) || (process.platform !== 'linux' && process.platform !== 'darwin')) {
    throw new RangeError('Owned setup requires an absolute executable path on Linux or macOS.')
  }
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1_024
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Setup timeout must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('Setup output limit must be a positive safe integer.')
  }
  const command = basename(executable) || 'setup command'
  if (options.signal?.aborted) {
    throw new SetupExecutionError('cancelled', command, true, null)
  }
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, [...argumentsList], {
      cwd: options.cwd,
      env: {
        ...options.environment,
      },
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let spawned = false
    let closed = false
    let settled = false
    let stopping = false
    let failure: SetupFailureKind | undefined
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    const finish = (terminationConfirmed: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout.destroy()
      child.stderr.destroy()
      if (failure !== undefined) {
        reject(new SetupExecutionError(failure, command, terminationConfirmed, exitCode))
        return
      }
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    }
    const stopped = () => closed && groupGone(child.pid)
    const wait = async (milliseconds: number): Promise<boolean> => {
      const deadline = Date.now() + milliseconds
      while (!stopped() && Date.now() < deadline) {
        await pause(SETUP_POLL_MS)
      }
      return stopped()
    }
    const stop = async () => {
      if (stopping || settled) {
        return
      }
      stopping = true
      const spawnDeadline = Date.now() + SETUP_TERM_GRACE_MS
      while (!spawned && !closed && Date.now() < spawnDeadline) {
        await pause(SETUP_POLL_MS)
      }
      if (spawned) {
        signalGroup(child.pid, 'SIGTERM')
      }
      if (await wait(SETUP_TERM_GRACE_MS)) {
        finish(true)
        return
      }
      if (spawned) {
        signalGroup(child.pid, 'SIGKILL')
      }
      finish(await wait(SETUP_KILL_GRACE_MS))
    }
    const fail = (kind: SetupFailureKind) => {
      failure ??= kind
      void stop()
    }
    const onAbort = () => fail('cancelled')
    const deadline = setTimeout(() => fail('timeout'), timeoutMs)
    const append = (chunks: Buffer[], chunk: Buffer) => {
      if (failure !== undefined || settled) {
        return
      }
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes) {
        fail('output')
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.once('spawn', () => {
      spawned = true
    })
    child.once('error', () => fail('start'))
    child.once('close', (code, signal) => {
      closed = true
      exitCode = code
      exitSignal = signal
      if (failure !== undefined) {
        void stop()
      } else if (code !== 0) {
        fail('exit')
      } else if (!groupGone(child.pid)) {
        fail('lifecycle')
      } else {
        finish(true)
      }
    })
    options.signal?.addEventListener('abort', onAbort, {
      once: true,
    })
    if (options.signal?.aborted) {
      onAbort()
    }
  })
}

export type AuthenticationFailureKind = 'start' | 'cancelled' | 'timeout' | 'exit' | 'protocol' | 'lifecycle'

export interface AuthenticationOptions {
  mode: 'interactive' | 'ipc'
  command: string
  signal: AbortSignal
  timeoutMs: number
  group: boolean
  onSpawn?: (fail: () => void) => void
  onMessage?: (message: unknown) => boolean
  accept?: () => boolean
}

export class AuthenticationExecutionError extends Error {
  constructor(
    public readonly kind: AuthenticationFailureKind,
    public readonly mode: AuthenticationOptions['mode'],
    public readonly command: string,
    public readonly terminationConfirmed: boolean,
  ) {
    super('The owned authentication process did not complete successfully.')
    this.name = 'AuthenticationExecutionError'
  }
}

/**
 * IPC children own a separate Unix process group. Interactive login retains the
 * terminal's existing process relationship and confirms only its direct child.
 * Neither mode contains work delegated to browsers or system services.
 */
export async function observeAuthentication(child: ChildProcess, options: AuthenticationOptions): Promise<void> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('Authentication deadlines must be positive safe integers.')
  }
  return await new Promise<void>((resolve, reject) => {
    let spawned = false
    let closed = false
    let settled = false
    let stopping = false
    let failure: AuthenticationFailureKind | undefined
    const stopped = () => closed && (!options.group || groupGone(child.pid))
    const signalChild = (signal: NodeJS.Signals) => {
      if (options.group) {
        signalGroup(child.pid, signal)
        return
      }
      try {
        child.kill(signal)
      } catch {
        // Subsequent observation establishes termination, not signal delivery.
      }
    }
    const finish = (terminationConfirmed: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      options.signal.removeEventListener('abort', onAbort)
      if (!terminationConfirmed) {
        // Outstanding activity retains its state and lock, but must not keep
        // the reporting process alive indefinitely.
        child.unref()
        child.channel?.unref()
      }
      if (failure !== undefined) {
        reject(new AuthenticationExecutionError(failure, options.mode, options.command, terminationConfirmed))
      } else {
        resolve()
      }
    }
    const wait = async (milliseconds: number): Promise<boolean> => {
      const deadline = Date.now() + milliseconds
      while (!stopped() && Date.now() < deadline) {
        await pause(SETUP_POLL_MS)
      }
      return stopped()
    }
    const stop = async () => {
      if (stopping || settled) {
        return
      }
      stopping = true
      const spawnDeadline = Date.now() + SETUP_TERM_GRACE_MS
      while (!spawned && !closed && Date.now() < spawnDeadline) {
        await pause(SETUP_POLL_MS)
      }
      if (spawned) {
        signalChild('SIGTERM')
      }
      if (await wait(SETUP_TERM_GRACE_MS)) {
        finish(true)
        return
      }
      if (spawned) {
        signalChild('SIGKILL')
      }
      finish(await wait(SETUP_KILL_GRACE_MS))
    }
    const fail = (kind: AuthenticationFailureKind) => {
      failure ??= kind
      void stop()
    }
    const onAbort = () => fail('cancelled')
    const deadline = setTimeout(() => fail('timeout'), options.timeoutMs)
    child.once('spawn', () => {
      spawned = true
      if (settled) {
        signalChild('SIGKILL')
        return
      }
      if (failure !== undefined) {
        return
      }
      try {
        options.onSpawn?.(() => fail('protocol'))
      } catch {
        fail('protocol')
      }
    })
    child.on('message', (message: unknown) => {
      if (settled || failure !== undefined) {
        return
      }
      try {
        if (!options.onMessage?.(message)) {
          fail('protocol')
        }
      } catch {
        fail('protocol')
      }
    })
    child.on('error', () => {
      if (!settled) {
        fail('start')
      }
    })
    child.once('close', (exitCode, exitSignal) => {
      closed = true
      if (settled) {
        return
      }
      if (failure !== undefined) {
        void stop()
      } else if (exitSignal === 'SIGINT' || exitSignal === 'SIGTERM') {
        fail('cancelled')
      } else if (exitCode !== 0) {
        fail('exit')
      } else if (options.accept && !options.accept()) {
        fail('protocol')
      } else if (!stopped()) {
        fail('lifecycle')
      } else {
        finish(true)
      }
    })
    options.signal.addEventListener('abort', onAbort, {
      once: true,
    })
    if (options.signal.aborted) {
      onAbort()
    }
  })
}
