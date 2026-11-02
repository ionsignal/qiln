import type { ChildProcess } from 'node:child_process'

const TERM_GRACE_MS = 2_000
const KILL_GRACE_MS = 2_000
const POLL_MS = 50

export type FailureKind = 'start' | 'cancelled' | 'timeout' | 'output' | 'exit' | 'protocol' | 'lifecycle'

export interface Exit {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface SuperviseOptions {
  command: string
  timeoutMs: number
  group: boolean
  signal?: AbortSignal
  unrefUnconfirmed?: boolean
  classifyExit?(exitCode: number | null, signal: NodeJS.Signals | null): FailureKind | undefined
  onSpawn?(fail: (kind: FailureKind) => void): void
  onMessage?(message: unknown): boolean
  accept?(): boolean
}

export interface Supervision {
  done: Promise<Exit>
  fail(kind: FailureKind): void
}

export class SupervisedProcessError extends Error {
  constructor(
    public readonly kind: FailureKind,
    public readonly command: string,
    public readonly terminationConfirmed: boolean,
    public readonly exitCode: number | null = null,
  ) {
    super(`The supervised process '${command}' did not complete successfully.`)
    this.name = 'SupervisedProcessError'
  }
}

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
 * Terminal interruption of a direct child is a cancellation, not an ordinary
 * failed exit.
 */
export function interruptedBySignal(
  _exitCode: number | null,
  signal: NodeJS.Signals | null,
): FailureKind | undefined {
  return signal === 'SIGINT' || signal === 'SIGTERM' ? 'cancelled' : undefined
}

/**
 * Owns the lifecycle of one spawned child. With `group`, the child must lead
 * its own Unix process group and termination is confirmed for that group, not
 * for descendants that escape it or work delegated to browsers and system
 * services. Without `group`, only the direct child is confirmed.
 */
export function supervise(child: ChildProcess, options: SuperviseOptions): Supervision {
  let fail!: (kind: FailureKind) => void
  const done = new Promise<Exit>((resolve, reject) => {
    let spawned = false
    let closed = false
    let settled = false
    let stopping = false
    let failure: FailureKind | undefined
    let exit: Exit = {
      exitCode: null,
      signal: null,
    }
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
    const settle = (terminationConfirmed: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (!terminationConfirmed && options.unrefUnconfirmed) {
        // Outstanding activity retains its state and lock, but must not keep
        // the reporting process alive indefinitely.
        child.unref()
        child.channel?.unref()
      }
      if (failure !== undefined) {
        reject(new SupervisedProcessError(failure, options.command, terminationConfirmed, exit.exitCode))
      } else {
        resolve(exit)
      }
    }
    const waitStopped = async (milliseconds: number): Promise<boolean> => {
      const limit = Date.now() + milliseconds
      while (!stopped() && Date.now() < limit) {
        await pause(POLL_MS)
      }
      return stopped()
    }
    const stop = async () => {
      if (stopping || settled) {
        return
      }
      stopping = true
      const spawnLimit = Date.now() + TERM_GRACE_MS
      while (!spawned && !closed && Date.now() < spawnLimit) {
        await pause(POLL_MS)
      }
      if (spawned) {
        signalChild('SIGTERM')
      }
      if (await waitStopped(TERM_GRACE_MS)) {
        settle(true)
        return
      }
      if (spawned) {
        signalChild('SIGKILL')
      }
      settle(await waitStopped(KILL_GRACE_MS))
    }
    fail = kind => {
      failure ??= kind
      void stop()
    }
    const onAbort = () => fail('cancelled')
    const timer = setTimeout(() => fail('timeout'), options.timeoutMs)
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
        options.onSpawn?.(fail)
      } catch {
        fail('protocol')
      }
    })
    const onMessage = options.onMessage
    if (onMessage) {
      child.on('message', (message: unknown) => {
        if (settled || failure !== undefined) {
          return
        }
        try {
          if (!onMessage(message)) {
            fail('protocol')
          }
        } catch {
          fail('protocol')
        }
      })
    }
    child.on('error', () => {
      if (!settled) {
        fail('start')
      }
    })
    child.once('close', (exitCode, exitSignal) => {
      closed = true
      exit = {
        exitCode,
        signal: exitSignal,
      }
      if (settled) {
        return
      }
      if (failure !== undefined) {
        void stop()
        return
      }
      const kind = options.classifyExit?.(exitCode, exitSignal) ?? (exitCode !== 0 ? 'exit' : undefined)
      if (kind !== undefined) {
        fail(kind)
      } else if (options.accept && !options.accept()) {
        fail('protocol')
      } else if (!stopped()) {
        fail('lifecycle')
      } else {
        settle(true)
      }
    })
    options.signal?.addEventListener('abort', onAbort, {
      once: true,
    })
    if (options.signal?.aborted) {
      onAbort()
    }
  })
  return {
    done,
    fail: kind => fail(kind),
  }
}
