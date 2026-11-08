import { AWS_SPEC } from '../spec'
import { markDispatched } from '../child/dispatch'
import type { EC2Client } from '@aws-sdk/client-ec2'

export interface Call {
  abortSignal: AbortSignal
}

/**
 * Thin EC2 boundary. Every call is a single attempt; mutations are never
 * polled or retried, and only reads are observed. Reads use a short bound so a
 * slow response surfaces as an error instead of consuming a polling budget.
 * Callers build their command first, so `write` marks dispatch only once
 * everything local is prepared.
 */
export class Ec2 {
  constructor(
    private readonly client: EC2Client,
    private readonly signal: AbortSignal,
  ) {}

  private call(timeoutMs: number, signal?: AbortSignal): Call {
    return {
      abortSignal: AbortSignal.any([
        this.signal,
        AbortSignal.timeout(timeoutMs),
        ...(signal === undefined ? [] : [signal]),
      ]),
    }
  }

  public read<T>(send: (client: EC2Client, call: Call) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return send(this.client, this.call(AWS_SPEC.deployment.readTimeoutMs, signal))
  }

  public async write<T>(send: (client: EC2Client, call: Call) => Promise<T>): Promise<T> {
    const call = this.call(AWS_SPEC.requestTimeoutMs)
    markDispatched()
    return await send(this.client, call)
  }
}
