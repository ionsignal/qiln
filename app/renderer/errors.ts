export class PageContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PageContextError'
  }
}
