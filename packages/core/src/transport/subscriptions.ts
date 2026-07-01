import type { Subscription } from '@nats-io/transport-node'

export class NatsSubscriptionTracker {
  private readonly subscriptions = new Set<Subscription>()

  get size(): number {
    return this.subscriptions.size
  }

  track<TSubscription extends Subscription>(subscription: TSubscription): TSubscription {
    this.subscriptions.add(subscription)
    return subscription
  }

  untrack(subscription: Subscription): void {
    this.subscriptions.delete(subscription)
  }

  unsubscribeSafely(subscription: Subscription): void {
    try {
      if (!subscription.isClosed()) {
        subscription.unsubscribe()
      }
    } catch {
      // Shutdown/drain races are expected when the connection is already closing.
    }
  }

  clear(): void {
    for (const subscription of this.subscriptions) {
      this.unsubscribeSafely(subscription)
    }
    this.subscriptions.clear()
  }
}
