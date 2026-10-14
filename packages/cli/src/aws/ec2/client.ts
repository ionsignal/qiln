import type { EC2Client } from '@aws-sdk/client-ec2'
import { AWS_SPEC } from '../spec'
import { markDispatched } from './dispatch'

export interface Call {
  abortSignal: AbortSignal
}

/**
 * Thin EC2 boundary. Every call is a single attempt; mutations are never
 * polled or retried, and only reads are observed. Callers build their command
 * first, so `write` marks dispatch only once everything local is prepared.
 */
export class Ec2 {
  constructor(
    private readonly client: EC2Client,
    private readonly signal: AbortSignal,
  ) {}

  private call(signal?: AbortSignal): Call {
    return {
      abortSignal: AbortSignal.any([
        this.signal,
        AbortSignal.timeout(AWS_SPEC.requestTimeoutMs),
        ...(signal === undefined ? [] : [signal]),
      ]),
    }
  }

  public read<T>(send: (client: EC2Client, call: Call) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return send(this.client, this.call(signal))
  }

  /** Only earlier failures are definite refusals, so dispatch is marked immediately before the send. */
  public async write<T>(send: (client: EC2Client, call: Call) => Promise<T>): Promise<T> {
    const call = this.call()
    markDispatched()
    return await send(this.client, call)
  }
}
