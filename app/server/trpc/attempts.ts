interface Counter {
  count: number
  resetsAt: number
}

interface AttemptsOptions {
  limit: number
  windowMs: number
  capacity?: number
}

/**
 * Process-local fixed-window counters. State is lost on restart and is never
 * shared between processes. Expired counters are removed lazily, and only a
 * full table is swept. A table that is still full refuses new keys, so growth
 * stays bounded and the limiter fails closed rather than open.
 */
export class Attempts {
  private readonly counters = new Map<string, Counter>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly capacity: number

  constructor({ limit, windowMs, capacity = 10_000 }: AttemptsOptions) {
    this.limit = limit
    this.windowMs = windowMs
    this.capacity = capacity
  }

  /**
   * Claims one slot for the key. False means the caller must refuse the work.
   */
  public take(key: string): boolean {
    const now = Date.now()
    const counter = this.counters.get(key)
    if (counter !== undefined && counter.resetsAt > now) {
      if (counter.count >= this.limit) {
        return false
      }
      counter.count++
      return true
    }
    if (counter === undefined && this.counters.size >= this.capacity) {
      this.sweep(now)
      if (this.counters.size >= this.capacity) {
        return false
      }
    }
    this.counters.set(key, { count: 1, resetsAt: now + this.windowMs })
    return true
  }

  /**
   * Returns one slot, dropping the key once nothing is held.
   */
  public release(key: string): void {
    const counter = this.counters.get(key)
    if (counter !== undefined && --counter.count <= 0) {
      this.counters.delete(key)
    }
  }

  private sweep(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.resetsAt <= now) {
        this.counters.delete(key)
      }
    }
  }
}
