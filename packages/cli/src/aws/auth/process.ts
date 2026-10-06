import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { configuration, credentials, expiresAt } from './credentials'
import { classify } from '../errors'
import { verifyIdentity } from './identity'
import { AWS_SPEC } from '../spec'
import { isRequest, type AwsAuthentication, type AwsReply } from '../types'

async function authenticate(region: string): Promise<AwsAuthentication> {
  const identityCredentials = await credentials(region)
  const client = new STSClient({
    ...configuration(region),
    credentials: identityCredentials,
  })
  try {
    const response = await client.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(AWS_SPEC.requestTimeoutMs),
    })
    return {
      identity: verifyIdentity({
        accountId: response.Account,
        arn: response.Arn,
        userId: response.UserId,
      }),
      expiresAt: expiresAt(identityCredentials),
    }
  } finally {
    client.destroy()
  }
}

function reply(message: AwsReply): void {
  if (!process.send || !process.connected) {
    process.exit(1)
  }
  process.send(message, error => {
    // The IPC callback runs after transmission. No credentials or provider
    // context survive into another request.
    process.exit(error ? 1 : 0)
  })
}

async function handle(message: unknown): Promise<void> {
  if (!isRequest(message)) {
    reply({
      ok: false,
      code: 'AWS_PROFILE_INVALID',
    })
    return
  }
  try {
    reply({
      ok: true,
      authentication: await authenticate(message.region),
    })
  } catch (error: unknown) {
    reply({
      ok: false,
      code: classify(error),
    })
  }
}
if (!process.send) {
  process.exitCode = 1
} else {
  process.umask(0o077)
  process.once('disconnect', () => process.exit(1))
  process.once('message', (message: unknown) => {
    void handle(message)
  })
}
