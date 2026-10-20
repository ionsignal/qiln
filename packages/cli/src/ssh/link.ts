/**
 * Connection-wide failure latch. It is set before a connection is destroyed, so
 * pending work fails with its own classification instead of being decided by
 * whichever library event happens to arrive first. Once set, it stays set.
 */
export class Link {
  public lost = false
  private readonly watchers = new Set<() => void>()

  public lose(): void {
    if (this.lost) {
      return
    }
    this.lost = true
    for (const watcher of [...this.watchers]) {
      watcher()
    }
  }

  public watch(watcher: () => void): () => void {
    this.watchers.add(watcher)
    return () => {
      this.watchers.delete(watcher)
    }
  }
}
