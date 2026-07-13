import type { CapsuleArchiveOutput, CapsuleDestroyOutput, CapsuleLifecycleIdempotencyKey, CapsuleUnarchiveOutput } from '@qiln/core/server'

export interface CapsuleLogicalLifecycleInput {
  ownerId: string
  capsuleId: string
  idempotencyKey: CapsuleLifecycleIdempotencyKey
}

export type CapsuleArchiveServiceInput = CapsuleLogicalLifecycleInput
export type CapsuleUnarchiveServiceInput = CapsuleLogicalLifecycleInput
export type CapsuleDestroyServiceInput = CapsuleLogicalLifecycleInput
export type CapsuleArchiveServiceOutput = CapsuleArchiveOutput
export type CapsuleUnarchiveServiceOutput = CapsuleUnarchiveOutput
export type CapsuleDestroyServiceOutput = CapsuleDestroyOutput
