import { isIP } from 'node:net'

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export interface UnixSocketEndpoint {
  transport: 'unix'
  socketPath: string
}

export interface HttpEndpoint {
  transport: 'http'
  baseUrl: string
}

export type IncusEndpoint = UnixSocketEndpoint | HttpEndpoint
export type CaddyAdminEndpoint = UnixSocketEndpoint | HttpEndpoint
export type RoutingIngressEndpoint = HttpEndpoint

export class EndpointValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EndpointValidationError'
  }
}

function assertRawEndpoint(value: string, label: string): void {
  if (value === '' || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new EndpointValidationError(`${label} must be a non-empty, trimmed endpoint URI without control characters.`)
  }
}

function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new EndpointValidationError(`${label} must be a valid endpoint URI.`)
  }
}

function assertNoCredentials(url: URL, label: string): void {
  if (url.username !== '' || url.password !== '') {
    throw new EndpointValidationError(`${label} cannot include URL credentials.`)
  }
}

function parseUnixSocketEndpoint(value: string, label: string): UnixSocketEndpoint {
  if (!value.startsWith('unix:///')) {
    throw new EndpointValidationError(`${label} Unix socket endpoints must use the form 'unix:///absolute/path.sock'.`)
  }
  const url = parseUrl(value, label)
  if (url.protocol !== 'unix:') {
    throw new EndpointValidationError(`${label} must use the 'unix:' URI scheme.`)
  }

  assertNoCredentials(url, label)

  if (url.hostname !== '' || url.search !== '' || url.hash !== '') {
    throw new EndpointValidationError(
      `${label} Unix socket endpoints cannot include a host, query string, or fragment.`,
    )
  }
  if (
    url.pathname.length <= 1 ||
    !url.pathname.startsWith('/') ||
    url.pathname.includes('%') ||
    url.pathname.trim() !== url.pathname ||
    CONTROL_CHARACTER_PATTERN.test(url.pathname)
  ) {
    throw new EndpointValidationError(`${label} must contain one concrete absolute Unix socket path.`)
  }
  return {
    transport: 'unix',
    socketPath: url.pathname,
  }
}

function parseHttpEndpoint(value: string, label: string, protocol: 'http:' | 'https:'): HttpEndpoint {
  const url = parseUrl(value, label)
  if (url.protocol !== protocol) {
    throw new EndpointValidationError(`${label} must use the '${protocol.slice(0, -1)}:' URI scheme.`)
  }

  assertNoCredentials(url, label)

  if (url.hostname === '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EndpointValidationError(
      `${label} must identify only one HTTP origin without a path, query string, or fragment.`,
    )
  }
  return {
    transport: 'http',
    baseUrl: url.origin,
  }
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname === '::1') {
    return true
  }
  if (isIP(hostname) !== 4) {
    return false
  }
  return hostname.startsWith('127.')
}

/**
 * Parses an Incus transport endpoint.
 *
 * Incus supports either a local Unix socket or an HTTPS endpoint. Plain HTTP is
 * intentionally excluded so remote Incus administration cannot silently lose
 * transport security.
 */
export function parseIncusEndpoint(value: string): IncusEndpoint {
  assertRawEndpoint(value, 'Incus endpoint')

  if (value.startsWith('unix:')) {
    return parseUnixSocketEndpoint(value, 'Incus endpoint')
  }
  return parseHttpEndpoint(value, 'Incus endpoint', 'https:')
}

/**
 * Parses one Caddy admin endpoint.
 *
 * The current basic integration uses loopback HTTP so the Worker and Caddy can
 * communicate inside one orchestrator container. Hardened deployments may use a
 * permissioned Unix socket. Non-loopback HTTP remains prohibited.
 */
export function parseCaddyAdminEndpoint(value: string): CaddyAdminEndpoint {
  assertRawEndpoint(value, 'Caddy admin endpoint')

  if (value.startsWith('unix:')) {
    return parseUnixSocketEndpoint(value, 'Caddy admin endpoint')
  }
  if (value.startsWith('https:')) return parseHttpEndpoint(value, 'Caddy admin endpoint', 'https:')
  const endpoint = parseHttpEndpoint(value, 'Caddy admin endpoint', 'http:')
  const hostname = new URL(endpoint.baseUrl).hostname
  if (!isLoopbackHostname(hostname)) {
    throw new EndpointValidationError(
      'Caddy admin HTTP endpoints must use a loopback hostname or address. Use a Unix socket for deployed administration.',
    )
  }
  return endpoint
}

/**
 * Parses the local ingress endpoint used to verify traffic through Caddy.
 *
 * Verification connects only to loopback. The desired route hostname is sent
 * separately through the HTTP Host header.
 */
export function parseRoutingIngressEndpoint(value: string): RoutingIngressEndpoint {
  assertRawEndpoint(value, 'Routing ingress endpoint')

  const endpoint = parseHttpEndpoint(value, 'Routing ingress endpoint', 'http:')
  const hostname = new URL(endpoint.baseUrl).hostname
  if (!isLoopbackHostname(hostname)) {
    throw new EndpointValidationError('Routing ingress verification must use a loopback HTTP endpoint.')
  }
  return endpoint
}
