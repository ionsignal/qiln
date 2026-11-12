import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

export type CredentialSource = Readonly<Record<string, string | undefined>>
export type HostCredential = z.output<typeof HostCredentialSchema>

const SecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9._+/@:=%-]+$/, 'must be non-empty and contain only A-Z a-z 0-9 . _ + / @ : = % -')

const Base64Schema = SecretSchema.transform((value, context) => {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    context.addIssue({ code: 'custom', message: 'must be canonical non-empty Base64' })
    return z.NEVER
  }
  return decoded.toString('utf8')
})

const NatsTokenSchema = z.object({
  NATS_TOKEN: SecretSchema,
})

const HostCredentialSchema = NatsTokenSchema.extend({
  FASTIFY_COOKIE_SECRET: SecretSchema,
  INCUS_CLIENT_CERT_B64: Base64Schema.optional(),
  INCUS_CLIENT_KEY_B64: Base64Schema.optional(),
})
  .refine(
    credential => (credential.INCUS_CLIENT_CERT_B64 === undefined) === (credential.INCUS_CLIENT_KEY_B64 === undefined),
    {
      message: 'INCUS_CLIENT_CERT_B64 and INCUS_CLIENT_KEY_B64 must be provided together.',
      path: ['INCUS_CLIENT_CERT_B64'],
    },
  )
  .transform(credential => ({
    natsToken: credential.NATS_TOKEN,
    cookieSecret: credential.FASTIFY_COOKIE_SECRET,
    incus: {
      cert: credential.INCUS_CLIENT_CERT_B64,
      key: credential.INCUS_CLIENT_KEY_B64,
    },
  }))


function parse<TOutput>(schema: z.ZodType<TOutput>, source: CredentialSource, label: string): TOutput {
  const result = schema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`${label} is invalid. ${issues.join('; ')}`)
  }
  return result.data
}

/**
 * Parses an installer-generated credential file. Only `KEY=VALUE` lines and
 * blank lines are accepted. Errors name line numbers and keys, never values.
 * Value grammar is enforced by the credential schemas, not here.
 */
export function parseCredentialFile(text: string): Record<string, string> {
  const entries = new Map<string, string>()
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') {
      continue
    }
    const separator = line.indexOf('=')
    const key = line.slice(0, separator)
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Credential file line ${index + 1} must be KEY=VALUE.`)
    }
    if (entries.has(key)) {
      throw new Error(`Credential file defines ${key} more than once (line ${index + 1}).`)
    }
    entries.set(key, line.slice(separator + 1))
  }
  return Object.fromEntries(entries)
}

/**
 * A configured credential file is the only source; otherwise the process
 * environment is. The two are never merged.
 */
export async function readCredentialSource(path: string | undefined): Promise<CredentialSource> {
  const file = path?.trim()
  return file ? parseCredentialFile(await readFile(file, 'utf8')) : process.env
}

export function parseHostCredential(source: CredentialSource): HostCredential {
  return parse(HostCredentialSchema, source, 'Host credential')
}

export function parseNatsToken(source: CredentialSource): string {
  return parse(NatsTokenSchema, source, 'NATS credential').NATS_TOKEN
}
