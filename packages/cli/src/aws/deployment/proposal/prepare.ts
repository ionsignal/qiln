import { InstallerError } from '../../../diagnostic/error'
import type { Session } from '../../auth/session'
import { request } from '../../child/request'
import { isReply, type Request } from '../../ec2/protocol'
import { AWS_SPEC } from '../../spec'
import { issueFacts } from './failure'
import type { Discovery } from './types'

/**
 * Read-only discovery of launch prerequisites. There is no deployment yet, so
 * no record tracks this child: an unconfirmed termination still retains the
 * operation lock through its error.
 */
export async function prepare(session: Session, signal: AbortSignal): Promise<Discovery> {
  const input: Request = { kind: 'prepare' }
  const reply = await request(AWS_SPEC.children.ec2, session.credentialEnvironment(), input, isReply, signal, {
    timeoutMs: AWS_SPEC.deployment.requestTimeoutMs,
  })
  if (!reply.ok) {
    throw new InstallerError({
      code: reply.code,
      facts: 'context' in reply ? issueFacts(reply.context) : [],
    })
  }
  if (reply.result.kind !== 'prepared') {
    throw new InstallerError({
      code: 'AWS_CONTEXT_FAILED',
    })
  }
  return reply.result.discovery
}
