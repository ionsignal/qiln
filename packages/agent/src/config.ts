import { isIP } from 'node:net'

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const MAX_API_KEY_LENGTH = 512

export interface QilnAgentConfig {
  url: string
  key: string
}

export class QilnAgentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QilnAgentConfigError'
  }
}

function isLoopbackHost(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') {
    return true
  }
  return isIP(host) === 4 && host.startsWith('127.')
}

function parseUrl(value: string): string {
  if (value === '' || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new QilnAgentConfigError('QILN_AGENT_URL must be a non-empty URL without whitespace or control characters.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new QilnAgentConfigError('QILN_AGENT_URL must be a valid Qiln host origin.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new QilnAgentConfigError('QILN_AGENT_URL cannot include URL credentials.')
  }
  if (url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new QilnAgentConfigError(
      'QILN_AGENT_URL must identify only a Qiln host origin without a path, query, or fragment.',
    )
  }
  if (url.protocol === 'https:') {
    return url.origin
  }
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
    return url.origin
  }
  throw new QilnAgentConfigError('QILN_AGENT_URL must use HTTPS, except for loopback HTTP during local development.')
}

function parseKey(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new QilnAgentConfigError('QILN_AGENT_KEY is required.')
  }
  if (value.length > MAX_API_KEY_LENGTH || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new QilnAgentConfigError('QILN_AGENT_KEY is malformed.')
  }
  return value
}

/**
 * Reads the complete external-agent connection boundary from environment
 * variables. API keys intentionally cannot be supplied through CLI arguments.
 */
export function readConfig(environment: NodeJS.ProcessEnv = process.env): QilnAgentConfig {
  return {
    url: parseUrl(environment.QILN_AGENT_URL ?? ''),
    key: parseKey(environment.QILN_AGENT_KEY),
  }
}
