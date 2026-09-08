import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { loadDotenv } from 'c12'
import { z } from 'zod'

const EnabledSchema = z.enum(['true', 'false']).transform(value => value === 'true')
const PortSchema = z.int().min(1).max(65_535)
const TimerSchema = z.int().min(1).max(2_147_483_647)

const SshConfigSchema = z
  .object({
    database: z.object({
      url: z.string().trim().min(1),
    }),
    nats: z.object({
      servers: z.array(z.string().trim().min(1)).min(1),
      token: z.string().min(1).optional(),
    }),
    policy: z.object({
      enabled: z.boolean(),
      ticketTtlMs: TimerSchema,
      relayClosureTimeoutMs: TimerSchema,
      publicHost: z.string().min(1),
      publicPort: PortSchema,
      gatewayHostAlias: z.string().min(1),
      branchHostAliasPrefix: z.string().min(1),
      defaultIdentityFile: z.string().min(1),
    }),
    gateway: z.object({
      enabled: z.boolean(),
      bindHost: z.string().trim().min(1),
      bindPort: PortSchema,
      instanceId: z.string(),
      hostKeyPath: z.string(),
      maxConnections: z.int().min(1),
      maxRelays: z.int().min(1),
      authenticationTimeoutMs: TimerSchema,
      channelOpenTimeoutMs: TimerSchema,
      branchDialTimeoutMs: TimerSchema,
    }),
  })
  .strict()

export type SshConfig = z.infer<typeof SshConfigSchema>

/**
 * Development retains the shared service credential file. Only its NATS token
 * enters SSH configuration; cookie and Incus credentials are not propagated
 * into configuration or process.env.
 */
async function loadNatsToken(): Promise<string | undefined> {
  const credentialPath = process.env.QILN_HOST_CREDENTIAL_PATH?.trim()
  if (!credentialPath) {
    return process.env.NATS_TOKEN || undefined
  }
  if (!isAbsolute(credentialPath)) {
    throw new Error('QILN_HOST_CREDENTIAL_PATH must be an absolute credential-file path.')
  }
  try {
    await access(credentialPath, constants.R_OK)
  } catch {
    throw new Error('The configured SSH NATS credential file is not readable.')
  }
  const environment = Object.create(null) as NodeJS.ProcessEnv
  const credentials = await loadDotenv({
    cwd: '/',
    fileName: credentialPath,
    env: environment,
    interpolate: false,
  })
  const parsed = z.object({ NATS_TOKEN: z.string().min(1) }).safeParse(credentials)
  if (!parsed.success) {
    throw new Error('The SSH credential file must contain a non-empty NATS_TOKEN.')
  }
  return parsed.data.NATS_TOKEN
}

/**
 * Loads only standalone SSH dependencies. Web configuration, authentication
 * configuration, and privileged Worker configuration are never imported.
 */
export async function loadSshConfig(): Promise<SshConfig> {
  if (process.env.QILN_LOAD_DOTENV !== 'false') {
    await loadDotenv({ cwd: process.cwd() })
  }
  const token = await loadNatsToken()
  return SshConfigSchema.parse({
    database: {
      url: process.env.DATABASE_URL ?? '',
    },
    nats: {
      servers: process.env.NATS_SERVERS ? process.env.NATS_SERVERS.split(',') : ['nats://localhost:4222'],
      ...(token === undefined ? {} : { token }),
    },
    policy: {
      enabled: EnabledSchema.parse(process.env.QILN_SSH_ENABLED ?? 'false'),
      ticketTtlMs: Number(process.env.QILN_SSH_TICKET_TTL_MS ?? '30000'),
      relayClosureTimeoutMs: Number(process.env.QILN_SSH_RELAY_CLOSURE_TIMEOUT_MS ?? '15000'),
      publicHost: process.env.QILN_SSH_PUBLIC_HOST || 'ssh.qiln.example',
      publicPort: Number(process.env.QILN_SSH_PUBLIC_PORT ?? '2222'),
      gatewayHostAlias: process.env.QILN_SSH_GATEWAY_HOST_ALIAS || 'qiln-gateway',
      branchHostAliasPrefix: process.env.QILN_SSH_BRANCH_HOST_ALIAS_PREFIX || 'qiln',
      defaultIdentityFile: process.env.QILN_SSH_DEFAULT_IDENTITY_FILE || '~/.ssh/id_ed25519_qiln',
    },
    gateway: {
      enabled: EnabledSchema.parse(process.env.QILN_SSH_GATEWAY_ENABLED ?? 'false'),
      bindHost: process.env.QILN_SSH_GATEWAY_BIND_HOST || '0.0.0.0',
      bindPort: Number(process.env.QILN_SSH_GATEWAY_BIND_PORT ?? '2222'),
      instanceId: process.env.QILN_SSH_GATEWAY_INSTANCE_ID || '',
      hostKeyPath: process.env.QILN_SSH_GATEWAY_HOST_KEY_PATH || '',
      maxConnections: Number(process.env.QILN_SSH_GATEWAY_MAX_CONNECTIONS ?? '256'),
      maxRelays: Number(process.env.QILN_SSH_GATEWAY_MAX_RELAYS ?? '128'),
      authenticationTimeoutMs: Number(process.env.QILN_SSH_GATEWAY_AUTHENTICATION_TIMEOUT_MS ?? '15000'),
      channelOpenTimeoutMs: Number(process.env.QILN_SSH_GATEWAY_CHANNEL_OPEN_TIMEOUT_MS ?? '10000'),
      branchDialTimeoutMs: Number(process.env.QILN_SSH_GATEWAY_BRANCH_DIAL_TIMEOUT_MS ?? '10000'),
    },
  })
}
