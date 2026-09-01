import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'

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
    if (pathEntry === '') {
      continue
    }
    const candidate = join(pathEntry, command)
    try {
      await access(candidate, constants.X_OK)
      return candidate
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
