import { spawn } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import type { ProcessOptions, ProcessResult } from '../../process'
import { SupervisedProcessError, supervise } from './supervise'

export interface SetupOptions extends ProcessOptions {
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
  umask?: {
    shell: string
    mask: number
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
  const umask = options.umask
  if (
    umask !== undefined &&
    (!isAbsolute(umask.shell) ||
      !Number.isSafeInteger(umask.mask) ||
      umask.mask < 0 ||
      umask.mask > 0o777)
  ) {
    throw new RangeError('Setup umasks require an absolute shell path and an integer mask between 0000 and 0777.')
  }
  const command = basename(executable) || 'setup command'
  if (options.signal?.aborted) {
    throw new SupervisedProcessError('cancelled', command, true)
  }
  // Fixed shell source keeps paths and command arguments out of shell evaluation.
  const spawnArguments =
    umask === undefined
      ? [...argumentsList]
      : [
          '-c',
          'umask "$1" && shift && exec "$@"',
          command,
          umask.mask.toString(8).padStart(4, '0'),
          executable,
          ...argumentsList,
        ]
  const child = spawn(umask?.shell ?? executable, spawnArguments, {
    cwd: options.cwd,
    env: {
      ...options.environment,
    },
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const { done, fail } = supervise(child, {
    command,
    timeoutMs,
    group: true,
    signal: options.signal,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  const append = (chunks: Buffer[], chunk: Buffer) => {
    if (outputBytes > maxOutputBytes) {
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
  try {
    const exit = await done
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }
  } finally {
    child.stdout.destroy()
    child.stderr.destroy()
  }
}
