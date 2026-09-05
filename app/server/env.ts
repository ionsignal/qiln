import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { loadConfig, loadDotenv } from 'c12'
import { z } from 'zod'
import type { EnvironmentConfig } from '@/types'

const CONFIG_FILE = 'app/dist/server/config'

const DevelopmentOriginSchema = z.string().transform((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    context.addIssue({
      code: 'custom',
      message:
        'QILN_DEV_PUBLIC_ORIGIN must be an HTTP(S) origin with one explicit hostname and no credentials, non-root path, query, or fragment.',
    })
    return z.NEVER
  }
  const invalid =
    value.trim() !== value ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === '' ||
    url.hostname.includes('*') ||
    url.port === '0' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  if (invalid) {
    context.addIssue({
      code: 'custom',
      message:
        'QILN_DEV_PUBLIC_ORIGIN must be an HTTP(S) origin with one explicit hostname and no credentials, non-root path, query, or fragment.',
    })
    return z.NEVER
  }
  return url.origin
})

const HostCredentialSchema = z
  .object({
    NATS_TOKEN: z.string().min(1),
    FASTIFY_COOKIE_SECRET: z.string().min(1),
    INCUS_CLIENT_CERT_B64: z.string().min(1).optional(),
    INCUS_CLIENT_KEY_B64: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    credentials =>
      (credentials.INCUS_CLIENT_CERT_B64 === undefined) === (credentials.INCUS_CLIENT_KEY_B64 === undefined),
    {
      message: 'INCUS_CLIENT_CERT_B64 and INCUS_CLIENT_KEY_B64 must be provided together.',
      path: ['INCUS_CLIENT_CERT_B64'],
    },
  )

type EnvironmentConfigOverrides = {
  cookies: {
    secret: string
  }
  incus?: {
    cert: string
    key: string
  }
  nats: {
    token: string
  }
}

function decodeBase64Credential(value: string, credentialName: string): string {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error(`Host credential ${credentialName} must be valid non-empty Base64.`)
  }
  return decoded.toString('utf8')
}

async function loadHostCredentialOverrides(): Promise<EnvironmentConfigOverrides | undefined> {
  const path = process.env.QILN_HOST_CREDENTIAL_PATH?.trim()
  if (path === undefined || path === '') {
    return undefined
  }
  if (!isAbsolute(path)) {
    throw new Error('QILN_HOST_CREDENTIAL_PATH must be an absolute credential-file path.')
  }
  try {
    await access(path, constants.R_OK)
  } catch {
    throw new Error('The configured Qiln Host credential file is not readable.')
  }
  const environment = Object.create(null) as NodeJS.ProcessEnv
  const credentials = await loadDotenv({
    cwd: '/',
    fileName: path,
    env: environment,
    interpolate: false,
  })
  const parsed = HostCredentialSchema.safeParse(credentials)
  if (!parsed.success) {
    throw new Error(
      'The Qiln Host credential file must contain non-empty NATS_TOKEN and FASTIFY_COOKIE_SECRET values. INCUS_CLIENT_CERT_B64 and INCUS_CLIENT_KEY_B64 are optional but must be provided together.',
    )
  }
  const { INCUS_CLIENT_CERT_B64: certBase64, INCUS_CLIENT_KEY_B64: keyBase64 } = parsed.data
  const overrides: EnvironmentConfigOverrides = {
    nats: {
      token: parsed.data.NATS_TOKEN,
    },
    cookies: {
      secret: parsed.data.FASTIFY_COOKIE_SECRET,
    },
  }
  if (certBase64 !== undefined && keyBase64 !== undefined) {
    overrides.incus = {
      cert: decodeBase64Credential(certBase64, 'INCUS_CLIENT_CERT_B64'),
      key: decodeBase64Credential(keyBase64, 'INCUS_CLIENT_KEY_B64'),
    }
  }
  return overrides
}

/**
 * Loads normal Host configuration and injects service-scoped credentials as
 * in-memory c12 overrides without copying credential values into process.env.
 */
export async function loadEnvironmentConfig(): Promise<EnvironmentConfig> {
  const overrides = await loadHostCredentialOverrides()
  const { config } = await loadConfig<EnvironmentConfig>({
    configFile: CONFIG_FILE,
    dotenv: process.env.QILN_LOAD_DOTENV !== 'false',
    ...(overrides === undefined
      ? {}
      : {
          overrides: overrides as EnvironmentConfig,
        }),
  })
  if (!config) {
    throw new Error('Application environment configuration is missing.')
  }
  if (config.dev) {
    config.development = {
      publicOrigin: DevelopmentOriginSchema.parse(config.development?.publicOrigin),
    }
  }
  return config
}
