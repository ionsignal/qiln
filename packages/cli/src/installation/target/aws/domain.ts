import { request } from '../../../aws/child/request'
import { replySchema, requestDeadlineMs, type Request, type Result } from '../../../aws/domain/protocol'
import { AWS_SPEC } from '../../../aws/spec'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import type { DomainAccess } from '../types'
import type { AwsHost } from './host'

const OUTCOMES = {
  rejected: 'refused; no DNS record or certificate was changed',
  uncertain: 'uncertain; DNS records or a certificate may already have changed',
} as const

function unexpected(retry: string): InstallerError {
  return new InstallerError({
    code: 'AWS_CONTEXT_FAILED',
    retry,
  })
}

/**
 * Every request runs in the isolated credential process of the deployment's
 * bound connection, which reloads its authority from durable evidence, checks
 * the saved login against the recorded operator, and signs and sends the proof
 * itself, so the session token never crosses IPC. A reply that arrived is kept
 * even if the command is cancelled afterwards, and the caller honors the
 * cancellation once it was persisted. Failures keep the child's certainty, and
 * a process-level failure after dispatch is uncertain. Errors are never wrapped,
 * so unconfirmed termination reaches the lock handling intact.
 */
export function awsDomain(aws: AwsHost, retry: string): DomainAccess {
  async function call(input: Request, signal: AbortSignal): Promise<Result> {
    const session = await aws.session()
    const reply = await request(AWS_SPEC.children.domain, session.credentialEnvironment(), input, replySchema, signal, {
      timeoutMs: requestDeadlineMs(input),
      keepReply: true,
      failure: error =>
        error.kind === 'cancelled'
          ? { retry }
          : {
              code: 'DOMAIN_SERVICE_UNAVAILABLE',
              facts: [
                ['Failure category', error.kind],
                ['Credential process termination', error.terminationConfirmed ? 'confirmed' : 'not confirmed'],
                ['Outcome', OUTCOMES.uncertain],
              ],
              retry,
            },
    })
    if (reply.ok) {
      return reply.result
    }
    const facts: DiagnosticFact[] = [['Outcome', OUTCOMES[reply.certainty]]]
    if ('service' in reply) {
      facts.push(['Service response', reply.service])
    }
    throw new InstallerError({
      code: reply.code,
      facts,
      retry: reply.code.startsWith('DOMAIN_') ? retry : 'qiln aws connect',
    })
  }
  return {
    service: AWS_SPEC.domain.origin,
    subject: aws.subject,
    async register(signal) {
      const result = await call({ kind: 'register', deploymentId: aws.record.id }, signal)
      if (result.kind !== 'registered') {
        throw unexpected(retry)
      }
      return result
    },
    async issue(csr, signal) {
      const result = await call({ kind: 'issue', deploymentId: aws.record.id, csr }, signal)
      if (result.kind !== 'issued') {
        throw unexpected(retry)
      }
      return result
    },
  }
}
