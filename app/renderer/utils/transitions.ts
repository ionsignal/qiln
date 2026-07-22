/**
 * Strict mapping of allowed transition events to their payload types.
 */
export type TransitionEventMap = {
  start: void
  finish: void
  error: void
}

type Handler = () => void

/**
 * A lightweight, dependency-free Pub/Sub Event Bus for cross-boundary
 * communication. Primarily used to trigger the Naive UI Loading Bar during Vike
 * client-side routing.
 */
class TransitionBus {
  private listeners: Record<keyof TransitionEventMap, Handler[]> = {
    start: [],
    finish: [],
    error: [],
  }

  on<K extends keyof TransitionEventMap>(event: K, handler: Handler): void {
    this.listeners[event].push(handler)
  }

  off<K extends keyof TransitionEventMap>(event: K, handler: Handler): void {
    this.listeners[event] = this.listeners[event].filter(h => h !== handler)
  }

  emit<K extends keyof TransitionEventMap>(event: K): void {
    this.listeners[event].forEach(h => h())
  }
}

export const transitionBus = new TransitionBus()
