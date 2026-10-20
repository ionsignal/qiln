import { z } from 'zod'
import { InstallerError } from '../diagnostic/error'
import { isFingerprint } from './key'

const MAXIMUM_DEADLINE_MS = 10 * 60 * 1_000
const MAXIMUM_OUTPUT_BYTES = 1_048_576
const MAXIMUM_UPLOAD_BYTES = 1_073_741_824

/**
 * Public connection parameters only. The private key is deliberately absent, so
 * it never passes through a schema or a diagnostic.
 */
export const sshOptionsSchema = z.strictObject({
  host: z.ipv4(),
  port: z.int().min(1).max(65_535),
  username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  fingerprint: z.string().refine(isFingerprint, 'Expected an unpadded SHA-256 fingerprint.'),
  connectTimeoutMs: z.int().min(1).max(MAXIMUM_DEADLINE_MS),
  commandTimeoutMs: z.int().min(1).max(MAXIMUM_DEADLINE_MS),
  maxOutputBytes: z.int().min(1).max(MAXIMUM_OUTPUT_BYTES),
})

export type SshOptions = z.infer<typeof sshOptionsSchema>

/**
 * Per-command bounds. The connection options supply the defaults.
 */
export const execLimitsSchema = z.strictObject({
  timeoutMs: z.int().min(1).max(MAXIMUM_DEADLINE_MS),
  maxOutputBytes: z.int().min(1).max(MAXIMUM_OUTPUT_BYTES),
})

export type ExecLimits = z.infer<typeof execLimitsSchema>

export const uploadLimitsSchema = z.strictObject({
  timeoutMs: z.int().min(1).max(MAXIMUM_DEADLINE_MS),
  bytes: z.int().min(1).max(MAXIMUM_UPLOAD_BYTES),
})

/**
 * Callers build options from retained evidence, so invalid options are a defect
 * of the caller, not an operator-correctable input.
 */
export function parseOptions(input: unknown): SshOptions {
  const parsed = sshOptionsSchema.safeParse(input)
  if (!parsed.success) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
  return parsed.data
}

/**
 * Per-call limits are caller-authored constants, so invalid ones are a defect
 * of the caller as well.
 */
export function parseLimits<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new InstallerError({
      code: 'INTERNAL_ERROR',
    })
  }
  return parsed.data
}
