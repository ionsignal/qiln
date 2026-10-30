import { z } from 'zod'
import { childReplySchema, COMMON_CODES } from '../child/protocol'
import { authenticationSchema, regionSchema } from '../types'

export const FAILURES = [
  'AWS_SSO_UNSUPPORTED',
  'AWS_PROFILE_INVALID',
  'AWS_ROOT_REFUSED',
  'AWS_PRINCIPAL_UNSUPPORTED',
  'AWS_IDENTITY_INVALID',
] as const

export const CODES = [...COMMON_CODES, ...FAILURES] as const

export type Code = (typeof CODES)[number]

export const requestSchema = z.strictObject({
  kind: z.literal('identity'),
  region: regionSchema,
})

export const replySchema = childReplySchema(authenticationSchema, CODES)

export type Request = z.infer<typeof requestSchema>
export type Reply = z.infer<typeof replySchema>
