import { z } from 'zod'
import { loadConfig } from 'c12'
import { parseHostCredential, readCredentialSource } from '@qiln/core/server'
import type { EnvironmentConfig, EnvironmentDefaults } from '@/types'

const CONFIG_FILE = 'app/dist/server/config'

const developmentOriginMessage =
  'QILN_DEV_PUBLIC_ORIGIN must be an HTTP(S) origin with one explicit hostname and no credentials, non-root path, query, or fragment.'

const DevelopmentOriginSchema = z.string().transform((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    context.addIssue({ code: 'custom', message: developmentOriginMessage })
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
    context.addIssue({ code: 'custom', message: developmentOriginMessage })
    return z.NEVER
  }
  return url.origin
})

/**
 * Loads normal Host configuration, then merges the validated Host credential.
 * Credentials come from the file named by QILN_HOST_CREDENTIAL_PATH or, when it
 * is unset, from the process environment (which `.env` may have populated).
 * Neither path writes credential values into process.env.
 */
export async function loadEnvironmentConfig(): Promise<EnvironmentConfig> {
  const { config: defaults } = await loadConfig<EnvironmentDefaults>({
    configFile: CONFIG_FILE,
    dotenv: process.env.QILN_LOAD_DOTENV !== 'false',
  })
  if (!defaults) {
    throw new Error('Application environment configuration is missing.')
  }
  const credential = parseHostCredential(await readCredentialSource(process.env.QILN_HOST_CREDENTIAL_PATH))
  return {
    ...defaults,
    development: defaults.dev
      ? { publicOrigin: DevelopmentOriginSchema.parse(defaults.development?.publicOrigin) }
      : defaults.development,
    cookies: { ...defaults.cookies, secret: credential.cookieSecret },
    nats: { ...defaults.nats, token: credential.natsToken },
    incus: { ...defaults.incus, ...credential.incus },
  }
}
