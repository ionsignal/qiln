import { webSchema } from './web'
import { sshSchema } from './ssh'

export { users } from './users'
export { sessions, agentCredentials } from './access'

export * from './capsule'
export * from './ssh'

/**
 * Complete physical schema for Drizzle tooling only.
 *
 * Runtime applications compose their own database dependencies without loading
 * the other application's implementation.
 */
export const schema = {
  ...webSchema,
  ...sshSchema,
} as const
