import path from 'node:path'
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

const defaultIncusEndpoint = 'unix:///var/snap/incus/common/incus/unix.socket'
const defaultCaddyEndpoint = 'unix:///run/qiln-caddy/admin.sock'
const defaultCaddyServer = 'qiln'
const defaultCaddyFallbackId = 'qiln-route-fallback-experimental'
const defaultRouteBaseDomain = 'edge.qiln.com'

// Helper to get the application path
const appPath = process.env.FASTIFY_APP_PATH ?? process.cwd()
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
  features: {
    experimentalSnapshots: process.env.QILN_EXPERIMENTAL_SNAPSHOTS_ENABLED === 'true',
  },
  cookies: {
    name: process.env.COOKIE_NAME ?? 'runemind_session',
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
  },
} satisfies EnvironmentConfig
