/**
 * Defines the mechanical routing protocol prefixes for global NATS communication.
 */
export const GlobalSubjectPrefix = {
  EVENT: 'gbl.evt',
  REQUEST: 'gbl.req',
} as const

/**
 * Standardized wildcards for global NATS subscriptions
 */
export const GlobalSubjectWildcards = {
  ALL_EVENTS: `${GlobalSubjectPrefix.EVENT}.>`,
  ALL_REQUESTS: `${GlobalSubjectPrefix.REQUEST}.>`,
} as const

/**
 * Centralized Parsed Subject Structure for all NATS Ingress.
 */
export interface ParsedSubject {
  prefix: string
  target: string
  domain: string
  action: string
}

/**
 * Centralized Subject Parser for all global NATS Ingress.
 */
export const UniversalSubjectParser = {
  /**
   * Safely extracts routing data from subjects like 'prefix.target.domain.action'
   * Uses a highly optimized string-splitting algorithm instead of Regex.
   */
  parse: (subject: string): ParsedSubject | null => {
    const parts = subject.split('.')
    if (parts.length < 5) return null
    return {
      prefix: `${parts[0]}.${parts[1]}`, // Reconstruct the 2-part prefix (e.g., 'ion.cmd' or 'gbl.req')
      target: parts[2],
      domain: parts[3],
      action: parts.slice(4).join('.'), // Join remaining parts for actions with dots (e.g., 'ensure_active')
    }
  },
}

export const UniversalSubjectBuilder = {
  /**
   * Constructs a standardized subject string across all ecosystem modules.
   */
  build: (prefix: string, target: string, domain: string, action: string): string => {
    return `${prefix}.${target}.${domain}.${action}`
  },
}
