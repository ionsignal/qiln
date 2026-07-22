import { z } from 'zod'

export const CapsuleBranchNameSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,48}[a-zA-Z0-9])?$/,
    'Capsule branch name must be alphanumeric, can contain hyphens, but cannot start or end with a hyphen.',
  )

/**
 * Runtime status of one capsule branch.
 *
 * Archive is capsule-level and leaves branches offline. Destroying and
 * destroyed are terminal capsule lifecycle states reflected onto branch runtime
 * records.
 */
export const CapsuleBranchStatusValues = [
  'provisioning',
  'offline',
  'starting',
  'online',
  'stopping',
  'destroying',
  'destroyed',
  'error',
  'cleanup_required',
] as const

export const CapsuleBranchStatusSchema = z.enum(CapsuleBranchStatusValues)

export type CapsuleBranchName = z.infer<typeof CapsuleBranchNameSchema>
export type CapsuleBranchStatus = z.infer<typeof CapsuleBranchStatusSchema>
