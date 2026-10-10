import { setTimeout as delay } from 'node:timers/promises'
import { InstallerError, type InstallerErrorCode } from '../diagnostic/error'

export interface Page<T> {
  items: readonly T[]
  truncated?: boolean
  marker?: string
}

export interface CollectOptions {
  maxPages: number
  code: InstallerErrorCode
}

export interface PollOptions {
  timeoutMs: number
  delayMs: number
  attempts: number
  code: InstallerErrorCode
}

/**
 * Reads every page of a bounded listing. Provider token styles map onto
 * `marker`; a missing or repeated marker, or too many pages, is a failure.
 */
export async function collect<T>(read: (marker?: string) => Promise<Page<T>>, options: CollectOptions): Promise<T[]> {
  const items: T[] = []
  const markers = new Set<string>()
  let marker: string | undefined
  for (let page = 0; page < options.maxPages; page++) {
    const result = await read(marker)
    items.push(...result.items)
    if (result.truncated !== true) {
      return items
    }
    if (!result.marker || markers.has(result.marker)) {
      throw new InstallerError({
        code: options.code,
      })
    }
    markers.add(result.marker)
    marker = result.marker
  }
  throw new InstallerError({
    code: options.code,
  })
}

/**
 * Only explicitly missing or unchanged expected observations are polled.
 * Request failures and unexpected state escape; mutations are never retried.
 * An exhausted budget does not prove that the observed effect did not occur.
 */
export async function poll(read: (signal: AbortSignal) => Promise<boolean>, options: PollOptions): Promise<void> {
  const signal = AbortSignal.timeout(options.timeoutMs)
  try {
    for (let attempt = 0; attempt < options.attempts; attempt++) {
      signal.throwIfAborted()
      if (await read(signal)) {
        return
      }
      if (attempt + 1 < options.attempts) {
        await delay(options.delayMs, undefined, { signal })
      }
    }
  } catch (error: unknown) {
    if (signal.aborted) {
      throw new InstallerError({
        code: options.code,
      })
    }
    throw error
  }
  throw new InstallerError({
    code: options.code,
  })
}
