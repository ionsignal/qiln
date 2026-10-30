import { z } from 'zod'

export const text = z.string().min(1).max(256)
export const count = z.int().nonnegative()
export const positive = z.int().positive()

/**
 * Returns the caller's original value, not Zod's output, because Zod follows
 * schema key order and persisted records and replies must keep theirs.
 */
export function accept<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | null {
  return schema.safeParse(value).success ? (value as z.output<S>) : null
}
