import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EnvironmentConfig } from '@/types'

const mode = process.env.NODE_ENV
const dev = mode !== 'production'
const host = (dev ? process.env.VITE_HOST_DEV : process.env.VITE_HOST_PROD) ?? 'localhost'

const defaultCaddyServer = 'qiln'
const defaultIncusEndpoint = 'unix:///run/qiln-incus.sock'
const defaultCaddyEndpoint = 'unix:///run/qiln-caddy/admin.sock'
const defaultCaddyFallbackId = 'qiln-route-fallback-experimental'
const defaultRouteBaseDomain = 'edge.qiln.com'
const defaultRoutingPublicOrigin = 'https://edge.qiln.com'
const defaultRoutingIngressEndpoint = 'http://127.0.0.1:8080'

// Helper to get the application path
const defaultAppPath = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const configuredAppPath = process.env.FASTIFY_APP_PATH?.trim()
const appPath = path.resolve(configuredAppPath || defaultAppPath)

// Helper to safely decode Base64 strings for mTLS certificates
const decodeBase64 = (value?: string) => (value ? Buffer.from(value, 'base64').toString('utf-8') : undefined)

// A malformed number fails startup instead of silently becoming a NaN limit.
function envInteger(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) {
    return fallback
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer.`)
  }
  return Number(value)
}

export default {
  dev,
  host,
  port: 3002,
  ssl: process.env.VITE_ENABLE_SSL ?? 'false',
  path: appPath,
  development: {
    // One public browser entrypoint is selected per development process.
    // This origin is independent from the internal Fastify listening address.
    publicOrigin: process.env.QILN_DEV_PUBLIC_ORIGIN ?? 'https://qiln.edge.ionsignal.com',
  },
  definitions: {
    path: process.env.APP_DEFINITIONS_PATH ?? path.join(appPath, 'catalog/blueprints'),
  },
  worker: {
    embedded: process.env.QILN_EMBEDDED_WORKER_ENABLED === 'true',
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
    directory: process.env.UPLOAD_DIRECTORY ?? 'data/projects',
    maxFieldSizeBytes: envInteger('UPLOAD_MAX_FIELD_SIZE_BYTES', 1024),
    maxFileSizeBytes: envInteger('UPLOAD_MAX_FILE_SIZE_BYTES', 5 * 1024 * 1024),
    maxFiles: envInteger('UPLOAD_MAX_FILES', 1),
    maxParts: envInteger('UPLOAD_MAX_PARTS', 10),
    maxHeaderPairs: envInteger('UPLOAD_MAX_HEADER_PAIRS', 50),
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
  observability: {
    queries: process.env.DATABASE_LOG_QUERIES === 'true',
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
    rejectUnauthorized: process.env.INCUS_REJECT_UNAUTHORIZED !== 'false',
    project: process.env.INCUS_PROJECT || undefined,
  },
  caddy: {
    endpoint: process.env.QILN_CADDY_ENDPOINT || defaultCaddyEndpoint,
    server: process.env.QILN_CADDY_SERVER || defaultCaddyServer,
    fallbackId: process.env.QILN_CADDY_FALLBACK_ID || defaultCaddyFallbackId,
    timeoutMs: envInteger('QILN_CADDY_REQUEST_TIMEOUT_MS', 15_000),
  },
  routing: {
    baseDomain: process.env.QILN_ROUTE_BASE_DOMAIN || defaultRouteBaseDomain,
    publicOrigin: process.env.QILN_ROUTING_PUBLIC_ORIGIN ?? defaultRoutingPublicOrigin,
    ingressEndpoint: process.env.QILN_ROUTING_INGRESS_ENDPOINT || defaultRoutingIngressEndpoint,
    reconcileIntervalMs: envInteger('QILN_PREVIEW_RECONCILE_INTERVAL_MS', 15_000),
    verificationTimeoutMs: envInteger('QILN_PREVIEW_VERIFICATION_TIMEOUT_MS', 10_000),
  },
} satisfies EnvironmentConfig
