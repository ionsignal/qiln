import { z } from 'zod'
import { CapsuleChannelErrorCodeSchema } from './channel'
import type { CapsuleChannelErrorCode, CapsuleCommandFailure } from './channel'

export const CapsuleRpcSuccessEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: z.unknown(),
  })
  .strict()

export const CapsuleRpcFailureEnvelopeSchema = z
  .object({
    success: z.literal(false),
    code: CapsuleChannelErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strict()

export const CapsuleRpcEnvelopeSchema = z.discriminatedUnion('success', [
  CapsuleRpcSuccessEnvelopeSchema,
  CapsuleRpcFailureEnvelopeSchema,
])

export type CapsuleRpcSuccessEnvelope<TData = unknown> = {
  success: true
  data: TData
}

export type CapsuleRpcFailureEnvelope = {
  success: false
  code: CapsuleChannelErrorCode
  message: string
  details?: unknown
}

export type CapsuleRpcEnvelope<TData = unknown> = CapsuleRpcSuccessEnvelope<TData> | CapsuleRpcFailureEnvelope

export function createCapsuleRpcSuccessEnvelope<TData>(data: TData): CapsuleRpcSuccessEnvelope<TData> {
  return {
    success: true,
    data,
  }
}

export function createCapsuleRpcFailureEnvelope(failure: CapsuleCommandFailure): CapsuleRpcFailureEnvelope {
  if (failure.details === undefined) {
    return {
      success: false,
      code: failure.code,
      message: failure.message,
    }
  }
  return {
    success: false,
    code: failure.code,
    message: failure.message,
    details: failure.details,
  }
}
