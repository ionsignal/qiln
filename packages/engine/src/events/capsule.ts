import { TargetType, type CapsuleChannel, type CapsuleEvent, type CapsuleEventEnvelope } from '@qiln/core/server'

const DEFAULT_MAX_QUEUE_SIZE = 500

interface CapsuleEventSubscriber {
  id: number
  ownerId: string
  active: boolean
  queue: CapsuleEvent[]
  resolveNext: (() => void) | null
}

export interface CapsuleEventHubOptions {
  maxQueueSize?: number
  loggerPrefix?: string
}

/**
 * Engine-local fanout layer for validated Capsule Channel events.
 *
 * This replaces the engine Fastify dispatcher bridge. NATS payload validation and
 * subject/target validation happen in `CapsuleNatsChannel`; this hub only handles
 * owner-scoped subscription lifecycle and bounded per-client queues.
 */
export class CapsuleEventHub {
  private readonly subscribers = new Set<CapsuleEventSubscriber>()
  private readonly maxQueueSize: number
  private readonly loggerPrefix: string

  private nextSubscriberId = 1
  private abortController: AbortController | null = null
  private loopPromise: Promise<void> | null = null

  constructor(
    private readonly channel: CapsuleChannel,
    options: CapsuleEventHubOptions = {},
  ) {
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this.loggerPrefix = options.loggerPrefix ?? '[QilnEngine CapsuleEvents]'
  }

  public start(): void {
    if (this.loopPromise) {
      return
    }
    this.abortController = new AbortController()
    this.loopPromise = this.run(this.abortController.signal)
  }

  public stop(): void {
    this.abortController?.abort()
    this.abortController = null
    for (const subscriber of this.subscribers) {
      this.closeSubscriber(subscriber)
    }
  }

  public async waitForStop(): Promise<void> {
    const loop = this.loopPromise
    if (!loop) {
      return
    }
    try {
      await loop
    } finally {
      this.loopPromise = null
    }
  }

  public async *subscribeForOwner(ownerId: string, signal: AbortSignal): AsyncIterable<CapsuleEvent> {
    if (signal.aborted) {
      return
    }
    const subscriber: CapsuleEventSubscriber = {
      id: this.nextSubscriberId++,
      ownerId,
      active: true,
      queue: [],
      resolveNext: null,
    }
    const onAbort = () => {
      this.closeSubscriber(subscriber)
    }
    this.subscribers.add(subscriber)
    signal.addEventListener('abort', onAbort)
    try {
      while (subscriber.active && !signal.aborted) {
        const event = subscriber.queue.shift()
        if (event) {
          yield event
          continue
        }
        await new Promise<void>(resolve => {
          subscriber.resolveNext = resolve

          if (!subscriber.active || signal.aborted) {
            this.wakeSubscriber(subscriber)
          }
        })
        subscriber.resolveNext = null
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.closeSubscriber(subscriber)
      this.subscribers.delete(subscriber)
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      for await (const envelope of this.channel.subscribe((_event, currentEnvelope) => currentEnvelope.target.type === TargetType.OWNER)) {
        if (signal.aborted) {
          break
        }
        this.dispatch(envelope)
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        console.error(`${this.loggerPrefix} Event subscription loop terminated unexpectedly.`, error)
      }
    }
  }

  private dispatch(envelope: CapsuleEventEnvelope): void {
    if (envelope.target.type !== TargetType.OWNER) {
      return
    }
    for (const subscriber of this.subscribers) {
      if (!subscriber.active || subscriber.ownerId !== envelope.target.id) {
        continue
      }
      if (subscriber.queue.length >= this.maxQueueSize) {
        subscriber.queue.shift()
        console.warn(`${this.loggerPrefix} Queue for owner ${subscriber.ownerId} exceeded ${this.maxQueueSize}. Dropping oldest event.`)
      }
      subscriber.queue.push(envelope.event)
      this.wakeSubscriber(subscriber)
    }
  }

  private closeSubscriber(subscriber: CapsuleEventSubscriber): void {
    subscriber.active = false
    subscriber.queue = []
    this.wakeSubscriber(subscriber)
  }

  private wakeSubscriber(subscriber: CapsuleEventSubscriber): void {
    const resolve = subscriber.resolveNext
    if (!resolve) {
      return
    }
    subscriber.resolveNext = null
    resolve()
  }
}
