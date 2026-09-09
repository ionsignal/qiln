import { users } from './users'
import { sessions, agentCredentials } from './access'
import { capsuleSchema } from './capsule'

/**
 * Web physical schema. SSH persistence is composed only by the SSH application
 * and the complete migration schema.
 */
export const webSchema = {
  users,
  sessions,
  agentCredentials,
  ...capsuleSchema,
} as const
