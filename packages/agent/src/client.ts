import {
  AgentGetContextInputSchema,
  AgentGetContextOutputSchema,
  type AgentGetContext,
  type AgentGetContextOutput,
} from '@qiln/core/client'
import type { QilnAgentConfig } from './config'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 1_048_576

export interface QilnAgentClientErrorOptions {
  status?: number
  code?: string
}

export class QilnAgentClientError extends Error {
  public readonly status?: number
  public readonly code?: string

  constructor(message: string, options: QilnAgentClientErrorOptions = {}) {
    super(message)
    this.name = 'QilnAgentClientError'
    this.status = options.status
    this.code = options.code
  }
}

interface AgentApiError {
  code: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function parseError(value: unknown): AgentApiError | null {
  if (!isRecord(value) || !isRecord(value.error)) {
    return null
  }
  const code = value.error.code
  const message = value.error.message
  if (
    typeof code !== 'string' ||
    code.length === 0 ||
    code.length > 128 ||
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > 2_000
  ) {
    return null
  }
  return {
    code,
    message,
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!isJsonContentType(response.headers.get('content-type'))) {
    throw new QilnAgentClientError('Qiln host returned an unexpected response content type.', {
      status: response.status,
    })
  }
  if (response.body === null) {
    throw new QilnAgentClientError('Qiln host returned an empty response body.', {
      status: response.status,
    })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let body = ''
  try {
    while (true) {
      const result = await reader.read()

      if (result.done) {
        break
      }
      totalBytes += result.value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)

        throw new QilnAgentClientError('Qiln host returned an unexpectedly large response.', {
          status: response.status,
        })
      }
      body += decoder.decode(result.value, {
        stream: true,
      })
    }
    body += decoder.decode()
  } catch (error: unknown) {
    if (error instanceof QilnAgentClientError) {
      throw error
    }
    throw new QilnAgentClientError('Qiln host response could not be read.', {
      status: response.status,
    })
  } finally {
    reader.releaseLock()
  }
  if (body === '') {
    throw new QilnAgentClientError('Qiln host returned an empty response body.', {
      status: response.status,
    })
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new QilnAgentClientError('Qiln host returned invalid JSON.', {
      status: response.status,
    })
  }
}

/**
 * Narrow external-agent client for the host-owned Qiln control-plane boundary.
 *
 * This client has no database, Worker, NATS, provider, filesystem, shell, or
 * route-controller access. Every authority decision remains host-derived.
 */
export class QilnAgentClient {
  private readonly contextUrl: string

  constructor(private readonly config: QilnAgentConfig) {
    this.contextUrl = new URL('/api/agent/v1/context', config.url).toString()
  }

  public async getContext(input: AgentGetContext = {}): Promise<AgentGetContextOutput> {
    const selector = AgentGetContextInputSchema.safeParse(input)
    if (!selector.success) {
      throw new QilnAgentClientError('The requested branch selector is invalid.')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(this.contextUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(selector.data),
        signal: controller.signal,
      })
    } catch {
      throw new QilnAgentClientError(
        controller.signal.aborted ? 'Qiln host request timed out.' : 'Could not reach the Qiln host.',
      )
    } finally {
      clearTimeout(timeout)
    }
    const body = await readJson(response)
    if (!response.ok) {
      const error = parseError(body)
      if (error) {
        throw new QilnAgentClientError(error.message, {
          status: response.status,
          code: error.code,
        })
      }
      throw new QilnAgentClientError('Qiln host rejected the agent request.', {
        status: response.status,
      })
    }
    const context = AgentGetContextOutputSchema.safeParse(body)
    if (!context.success) {
      throw new QilnAgentClientError('Qiln host returned an invalid agent context response.', {
        status: response.status,
      })
    }
    return context.data
  }
}
