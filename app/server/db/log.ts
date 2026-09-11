import type { Logger } from 'drizzle-orm/logger'

/**
 * Bound values may contain credentials, so diagnostics include only their
 * count. SQL text remains visible, including any inline literals.
 */
export class QueryLogger implements Logger {
  public logQuery(query: string, params: unknown[]): void {
    console.log(`[Db] Query (${params.length} parameters): ${query}`)
  }
}
