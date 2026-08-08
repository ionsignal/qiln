import {
  AgentGetContextInputSchema,
  AgentGetContextOutputSchema,
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotArtifactContentOutputSchema,
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestEntriesOutputSchema,
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotManifestRootsOutputSchema,
  type AgentGetContext,
  type AgentGetContextOutput,
  type AgentSnapshotArtifactContentRequest,
  type AgentSnapshotArtifactContentOutput,
  type AgentSnapshotManifestEntries,
  type AgentSnapshotManifestEntriesOutput,
  type AgentSnapshotManifestRoots,
  type AgentSnapshotManifestRootsOutput,
} from '@qiln/core/client'
import type { QilnAgentConfig } from './config'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_CONTEXT_RESPONSE_BYTES = 1_048_576
const MAX_MANIFEST_RESPONSE_BYTES = 4 * 1_024 * 1_024
const MAX_CONTENT_RESPONSE_BYTES = 512 * 1_024

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

interface AgentApiResponse {
  response: Response
  body: unknown
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

function throwRejectedResponse(response: Response, body: unknown): never {
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

async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
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
      if (totalBytes > maxBytes) {
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
    throw new QilnAgentClientError(
      signal.aborted ? 'Qiln host request timed out.' : 'Qiln host response could not be read.',
      {
        status: response.status,
      },
    )
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
  private readonly manifestRootsUrl: string
  private readonly manifestEntriesUrl: string
  private readonly artifactContentUrl: string

  constructor(private readonly config: QilnAgentConfig) {
    this.contextUrl = new URL('/api/agent/v1/context', config.url).toString()
    this.manifestRootsUrl = new URL('/api/agent/v1/snapshot/manifest/roots', config.url).toString()
    this.manifestEntriesUrl = new URL('/api/agent/v1/snapshot/manifest/entries', config.url).toString()
    this.artifactContentUrl = new URL('/api/agent/v1/snapshot/artifact/content', config.url).toString()
  }

  public async getContext(input: AgentGetContext = {}): Promise<AgentGetContextOutput> {
    const selector = AgentGetContextInputSchema.safeParse(input)
    if (!selector.success) {
      throw new QilnAgentClientError('The requested branch selector is invalid.')
    }
    const result = await this.post(this.contextUrl, selector.data, MAX_CONTEXT_RESPONSE_BYTES)
    if (!result.response.ok) {
      throwRejectedResponse(result.response, result.body)
    }
    const context = AgentGetContextOutputSchema.safeParse(result.body)
    if (!context.success) {
      throw new QilnAgentClientError('Qiln host returned an invalid agent context response.', {
        status: result.response.status,
      })
    }
    return context.data
  }

  public async manifestRoots(input: AgentSnapshotManifestRoots): Promise<AgentSnapshotManifestRootsOutput> {
    const request = AgentSnapshotManifestRootsInputSchema.safeParse(input)
    if (!request.success) {
      throw new QilnAgentClientError('The requested snapshot manifest root read is invalid.')
    }
    const result = await this.post(this.manifestRootsUrl, request.data, MAX_MANIFEST_RESPONSE_BYTES)
    if (!result.response.ok) {
      throwRejectedResponse(result.response, result.body)
    }
    const output = AgentSnapshotManifestRootsOutputSchema.safeParse(result.body)
    if (!output.success) {
      throw new QilnAgentClientError('Qiln host returned an invalid snapshot manifest root response.', {
        status: result.response.status,
      })
    }
    return output.data
  }

  public async manifestEntries(input: AgentSnapshotManifestEntries): Promise<AgentSnapshotManifestEntriesOutput> {
    const request = AgentSnapshotManifestEntriesInputSchema.safeParse(input)
    if (!request.success) {
      throw new QilnAgentClientError('The requested snapshot manifest entry read is invalid.')
    }
    const result = await this.post(this.manifestEntriesUrl, request.data, MAX_MANIFEST_RESPONSE_BYTES)
    if (!result.response.ok) {
      throwRejectedResponse(result.response, result.body)
    }
    const output = AgentSnapshotManifestEntriesOutputSchema.safeParse(result.body)
    if (!output.success) {
      throw new QilnAgentClientError('Qiln host returned an invalid snapshot manifest entry response.', {
        status: result.response.status,
      })
    }
    return output.data
  }

  public async artifactContent(
    input: AgentSnapshotArtifactContentRequest,
  ): Promise<AgentSnapshotArtifactContentOutput> {
    const request = AgentSnapshotArtifactContentRequestSchema.safeParse(input)
    if (!request.success) {
      throw new QilnAgentClientError('The requested snapshot artifact content read is invalid.')
    }
    const result = await this.post(this.artifactContentUrl, request.data, MAX_CONTENT_RESPONSE_BYTES)
    if (!result.response.ok) {
      throwRejectedResponse(result.response, result.body)
    }
    const output = AgentSnapshotArtifactContentOutputSchema.safeParse(result.body)
    if (!output.success) {
      throw new QilnAgentClientError('Qiln host returned an invalid snapshot artifact content response.', {
        status: result.response.status,
      })
    }
    return output.data
  }

  private async post(url: string, body: unknown, maxResponseBytes: number): Promise<AgentApiResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      return {
        response,
        body: await readJson(response, maxResponseBytes, controller.signal),
      }
    } catch (error: unknown) {
      if (error instanceof QilnAgentClientError) {
        throw error
      }
      throw new QilnAgentClientError(
        controller.signal.aborted ? 'Qiln host request timed out.' : 'Could not reach the Qiln host.',
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
