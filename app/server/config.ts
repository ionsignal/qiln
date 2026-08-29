import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EnvironmentConfig, MultipartConfig } from '@/types'

const mode = process.env.NODE_ENV
const dev = mode !== 'production'
const host = (dev ? process.env.VITE_HOST_DEV : process.env.VITE_HOST_PROD) ?? 'localhost'

const defaultMultipartLimits: MultipartConfig = {
  directory: 'data/projects',
  maxFieldSizeBytes: 1024,
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxFiles: 1,
  maxParts: 10,
  maxHeaderPairs: 50,
}

const defaultRateLimitConfig = {
  global: true,
  max: 10,
  timeWindow: 250,
}

const defaultIncusEndpoint = 'unix:///run/qiln-incus.sock'
const defaultCaddyEndpoint = 'unix:///run/qiln-caddy/admin.sock'
const defaultCaddyServer = 'qiln'
const defaultCaddyFallbackId = 'qiln-route-fallback-experimental'
const defaultRouteBaseDomain = 'edge.ionsignal.com'
const defaultRoutingIngressEndpoint = 'http://127.0.0.1:8080'
const defaultSshPublicHost = 'ssh.qiln.example'
const defaultSshPublicPort = 2222
const defaultSshTicketTtlMs = 30_000
const defaultSshRelayClosureTimeoutMs = 15_000
const defaultSshGatewayBindHost = '0.0.0.0'
const defaultSshGatewayBindPort = 2222
const defaultSshGatewayMaxConnections = 256
const defaultSshGatewayMaxRelays = 128
const defaultSshGatewayAuthenticationTimeoutMs = 15_000
const defaultSshGatewayChannelOpenTimeoutMs = 10_000
const defaultSshGatewayBranchDialTimeoutMs = 10_000

// Helper to get the application path
const defaultAppPath = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const configuredAppPath = process.env.FASTIFY_APP_PATH?.trim()
const appPath = path.resolve(configuredAppPath || defaultAppPath)

// Helper to safely decode Base64 strings for mTLS certificates
const decodeBase64 = (value?: string) => (value ? Buffer.from(value, 'base64').toString('utf-8') : undefined)
export default {
  dev,
  host,
  listen: !dev,
  port: 3002,
  ssl: process.env.VITE_ENABLE_SSL ?? 'false',
  path: appPath,
  definitions: {
    path: process.env.APP_DEFINITIONS_PATH ?? path.join(appPath, 'catalog/blueprints'),
  },
  worker: {
    embedded: process.env.QILN_EMBEDDED_WORKER_ENABLED === 'true',
  },
  ssh: {
    enabled: process.env.QILN_SSH_ENABLED === 'true',
    ticketTtlMs: parseInt(process.env.QILN_SSH_TICKET_TTL_MS ?? String(defaultSshTicketTtlMs), 10),
    relayClosureTimeoutMs: parseInt(
      process.env.QILN_SSH_RELAY_CLOSURE_TIMEOUT_MS ?? String(defaultSshRelayClosureTimeoutMs),
      10,
    ),
    publicHost: process.env.QILN_SSH_PUBLIC_HOST || defaultSshPublicHost,
    publicPort: parseInt(process.env.QILN_SSH_PUBLIC_PORT ?? String(defaultSshPublicPort), 10),
    gatewayHostAlias: process.env.QILN_SSH_GATEWAY_HOST_ALIAS || 'qiln-gateway',
    branchHostAliasPrefix: process.env.QILN_SSH_BRANCH_HOST_ALIAS_PREFIX || 'qiln',
    defaultIdentityFile: process.env.QILN_SSH_DEFAULT_IDENTITY_FILE || '~/.ssh/id_ed25519_qiln',
    gateway: {
      enabled: process.env.QILN_SSH_GATEWAY_ENABLED === 'true',
      bindHost: process.env.QILN_SSH_GATEWAY_BIND_HOST || defaultSshGatewayBindHost,
      bindPort: parseInt(process.env.QILN_SSH_GATEWAY_BIND_PORT ?? String(defaultSshGatewayBindPort), 10),
      instanceId: process.env.QILN_SSH_GATEWAY_INSTANCE_ID || '',
      hostKeyPath: process.env.QILN_SSH_GATEWAY_HOST_KEY_PATH || '',
      maxConnections: parseInt(
        process.env.QILN_SSH_GATEWAY_MAX_CONNECTIONS ?? String(defaultSshGatewayMaxConnections),
        10,
      ),
      maxRelays: parseInt(process.env.QILN_SSH_GATEWAY_MAX_RELAYS ?? String(defaultSshGatewayMaxRelays), 10),
      authenticationTimeoutMs: parseInt(
        process.env.QILN_SSH_GATEWAY_AUTHENTICATION_TIMEOUT_MS ?? String(defaultSshGatewayAuthenticationTimeoutMs),
        10,
      ),
      channelOpenTimeoutMs: parseInt(
        process.env.QILN_SSH_GATEWAY_CHANNEL_OPEN_TIMEOUT_MS ?? String(defaultSshGatewayChannelOpenTimeoutMs),
        10,
      ),
      branchDialTimeoutMs: parseInt(
        process.env.QILN_SSH_GATEWAY_BRANCH_DIAL_TIMEOUT_MS ?? String(defaultSshGatewayBranchDialTimeoutMs),
        10,
      ),
    },
  },
  features: {
    experimentalSnapshots: process.env.QILN_EXPERIMENTAL_SNAPSHOTS_ENABLED === 'true',
  },
  cookies: {
    name: process.env.COOKIE_NAME ?? 'runemind_session',
    secret: process.env.FASTIFY_COOKIE_SECRET,
    path: '/',
    domain: host === 'localhost' ? undefined : host,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24,
  },
  multipart: {
    directory: process.env.UPLOAD_DIRECTORY ?? defaultMultipartLimits.directory,
    maxFieldSizeBytes: parseInt(
      process.env.UPLOAD_MAX_FIELD_SIZE_BYTES ?? String(defaultMultipartLimits.maxFieldSizeBytes),
      10,
    ),
    maxFileSizeBytes: parseInt(
      process.env.UPLOAD_MAX_FILE_SIZE_BYTES ?? String(defaultMultipartLimits.maxFileSizeBytes),
      10,
    ),
    maxFiles: parseInt(process.env.UPLOAD_MAX_FILES ?? String(defaultMultipartLimits.maxFiles), 10),
    maxParts: parseInt(process.env.UPLOAD_MAX_PARTS ?? String(defaultMultipartLimits.maxParts), 10),
    maxHeaderPairs: parseInt(process.env.UPLOAD_MAX_HEADER_PAIRS ?? String(defaultMultipartLimits.maxHeaderPairs), 10),
  },
  limit: {
    global: Boolean(process.env.RATE_LIMIT_GLOBAL) || defaultRateLimitConfig.global,
    max: parseInt(process.env.RATE_LIMIT_MAX ?? String(defaultRateLimitConfig.max), 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_TIME_WINDOW_MS ?? String(defaultRateLimitConfig.timeWindow), 10),
  },
  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY ?? '',
    domain: process.env.MAILGUN_DOMAIN ?? '',
    from: process.env.MAILGUN_FROM_EMAIL ?? '',
    mailingList: process.env.MAILGUN_MAILING_LIST ?? '',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  nats: {
    servers: process.env.NATS_SERVERS ? process.env.NATS_SERVERS.split(',') : ['nats://localhost:4222'],
    token: process.env.NATS_TOKEN || undefined,
  },
  incus: {
    endpoint: process.env.INCUS_ENDPOINT || defaultIncusEndpoint,
    cert: decodeBase64(process.env.INCUS_CLIENT_CERT_B64),
    key: decodeBase64(process.env.INCUS_CLIENT_KEY_B64),
    basicAuth: process.env.INCUS_BASIC_AUTH,
    rejectUnauthorized: process.env.INCUS_REJECT_UNAUTHORIZED === 'true',
    project: process.env.INCUS_PROJECT || undefined,
  },
  caddy: {
    endpoint: process.env.QILN_CADDY_ENDPOINT || defaultCaddyEndpoint,
    server: process.env.QILN_CADDY_SERVER || defaultCaddyServer,
    fallbackId: process.env.QILN_CADDY_FALLBACK_ID || defaultCaddyFallbackId,
    timeoutMs: parseInt(process.env.QILN_CADDY_REQUEST_TIMEOUT_MS ?? '15000', 10),
  },
  routing: {
    baseDomain: process.env.QILN_ROUTE_BASE_DOMAIN || defaultRouteBaseDomain,
    ingressEndpoint: process.env.QILN_ROUTING_INGRESS_ENDPOINT || defaultRoutingIngressEndpoint,
    reconcileIntervalMs: parseInt(process.env.QILN_PREVIEW_RECONCILE_INTERVAL_MS ?? '15000', 10),
    verificationTimeoutMs: parseInt(process.env.QILN_PREVIEW_VERIFICATION_TIMEOUT_MS ?? '10000', 10),
  },
} satisfies EnvironmentConfig
