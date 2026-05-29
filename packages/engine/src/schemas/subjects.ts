/**
 * Defines the mechanical routing protocol prefixes for NATS communication.
 */
export const SubjectPrefix = {
  EVENT: 'hst.evt',
  REQUEST: 'hst.req',
} as const

/**
 * Standardized wildcards for NATS subscriptions
 */
export const SubjectWildcards = {
  ALL_EVENTS: `${SubjectPrefix.EVENT}.>`,
  ALL_REQUESTS: `${SubjectPrefix.REQUEST}.>`,
} as const
