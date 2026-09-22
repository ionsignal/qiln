import { CapsuleOperationIdempotencyKeySchema, type CapsuleOperationIdempotencyKey } from '@qiln/core/client'

/**
 * Generates a browser-owned operation key without introducing SSR randomness.
 *
 * Callers retain the key alongside the exact pending intent so an uncertain
 * submission can be retried without creating another operation.
 */
export function createIdempotencyKey(): CapsuleOperationIdempotencyKey | null {
  if (import.meta.env.SSR || typeof globalThis.crypto?.randomUUID !== 'function') {
    return null
  }
  const result = CapsuleOperationIdempotencyKeySchema.safeParse(globalThis.crypto.randomUUID())
  return result.success ? result.data : null
}
