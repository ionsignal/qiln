import { FAILURES, requestSchema } from './protocol'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { configuration, credentials, expiresAt } from './credentials'
import { classifier } from '../child/classify'
import { serveChild } from '../child/serve'
import { verifyIdentity } from './identity'
import { AWS_SPEC } from '../spec'
import type { AwsAuthentication } from '../types'

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

serveChild({
  requestSchema,
  execute: request => authenticate(request.region),
  classify: classifier(FAILURES),
  invalidRequest: 'AWS_PROFILE_INVALID',
})
