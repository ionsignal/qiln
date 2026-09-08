import { users, sessions, agentCredentials, schema as webSchema } from '../server/db/schema'
import { sshSchema } from './ssh'

export { users, sessions, agentCredentials }
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
