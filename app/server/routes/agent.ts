import { MAX_AGENT_SNAPSHOT_READ_REQUEST_BYTES, CapsuleChannelError, CapsuleChannelErrorCode } from '@qiln/core/server'
import { AgentBranchNotFoundError, AgentUnauthorizedError, resolveAgentContext } from '@server/agent/context'
import { readAgentBearerKey } from '@server/agent/key'
import {
  AgentArtifactContentDeniedError,
  AgentSnapshotArtifactContentRequestSchema,
  AgentSnapshotManifestEntriesInputSchema,
  AgentSnapshotManifestRootsInputSchema,
  AgentSnapshotNotFoundError,
  resolveAgentArtifactContent,
  resolveAgentManifestEntries,
  resolveAgentManifestRoots,
} from '@server/agent/snapshot'
import { AgentGetContextInputSchema } from '@qiln/core/server'
import type { FastifyInstance } from 'fastify'

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function contextChannelFailure(error: unknown): {
  statusCode: number
  code: string
  message: string
} | null {
  if (!(error instanceof CapsuleChannelError)) {
    return null
  }
  switch (error.code) {
    case CapsuleChannelErrorCode.BAD_REQUEST:
      return {
        statusCode: 400,
        code: 'bad_request',
        message: 'Could not resolve the requested agent context.',
      }
    case CapsuleChannelErrorCode.UNAUTHORIZED:
      return {
        statusCode: 401,
        code: 'unauthorized',
        message: 'Unauthorized agent credential.',
      }
    case CapsuleChannelErrorCode.FORBIDDEN:
      return {
        statusCode: 403,
        code: 'forbidden',
        message: 'The requested capsule context is not available.',
      }
    case CapsuleChannelErrorCode.NOT_FOUND:
      return {
        statusCode: 404,
        code: 'not_found',
        message: 'The requested capsule context was not found.',
      }
    case CapsuleChannelErrorCode.CONFLICT:
      return {
        statusCode: 409,
        code: 'snapshot_unavailable',
        message: 'Committed snapshot context evidence is unavailable.',
      }
    case CapsuleChannelErrorCode.TIMEOUT:
      return {
        statusCode: 504,
        code: 'upstream_timeout',
        message: 'Committed snapshot context selection timed out.',
      }
    case CapsuleChannelErrorCode.TRANSPORT_ERROR:
      return {
        statusCode: 503,
        code: 'upstream_unavailable',
        message: 'Committed snapshot context selection is temporarily unavailable.',
      }
    case CapsuleChannelErrorCode.INTERNAL_ERROR:
    default:
      return {
        statusCode: 500,
        code: 'internal_error',
        message: 'Internal agent API error.',
      }
  }
}

function readFailure(error: unknown): {
  statusCode: number
  code: string
  message: string
} {
  if (error instanceof AgentSnapshotNotFoundError) {
    return {
      statusCode: 404,
      code: 'not_found',
      message: 'Snapshot not found.',
    }
  }
  if (error instanceof AgentArtifactContentDeniedError) {
    return {
      statusCode: 403,
      code: 'artifact_content_denied',
      message: 'Artifact content is not available for this snapshot.',
    }
  }
  if (!(error instanceof CapsuleChannelError)) {
    return {
      statusCode: 500,
      code: 'internal_error',
      message: 'Internal agent API error.',
    }
  }
  switch (error.code) {
    case CapsuleChannelErrorCode.NOT_FOUND:
      return {
        statusCode: 404,
        code: 'not_found',
        message: 'Snapshot artifact not found.',
      }
    case CapsuleChannelErrorCode.FORBIDDEN:
    case CapsuleChannelErrorCode.UNAUTHORIZED:
      return {
        statusCode: 403,
        code: 'artifact_content_denied',
        message: 'Artifact content is not available for this snapshot.',
      }
    case CapsuleChannelErrorCode.CONFLICT:
      return {
        statusCode: 409,
        code: 'snapshot_unavailable',
        message: 'Committed snapshot artifact evidence is unavailable.',
      }
    case CapsuleChannelErrorCode.TIMEOUT:
      return {
        statusCode: 504,
        code: 'upstream_timeout',
        message: 'Committed snapshot artifact read timed out.',
      }
    case CapsuleChannelErrorCode.TRANSPORT_ERROR:
      return {
        statusCode: 503,
        code: 'upstream_unavailable',
        message: 'Committed snapshot artifact reads are temporarily unavailable.',
      }
    case CapsuleChannelErrorCode.BAD_REQUEST:
      return {
        statusCode: 400,
        code: 'bad_request',
        message: 'Invalid snapshot read request.',
      }
    case CapsuleChannelErrorCode.INTERNAL_ERROR:
    default:
      return {
        statusCode: 500,
        code: 'internal_error',
        message: 'Internal agent API error.',
      }
  }
}

/**
 * External agent access is intentionally separate from browser sessions and
 * tRPC. These routes derive all authority from a host-owned API credential.
 */
export default async function (fastify: FastifyInstance) {
  fastify.post('/api/agent/v1/context', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!isJsonContentType(request.headers['content-type'])) {
      return reply.code(415).send({
        error: {
          code: 'unsupported_media_type',
          message: 'Expected application/json.',
        },
      })
    }
    const parsedInput = AgentGetContextInputSchema.safeParse(request.body)
    if (!parsedInput.success) {
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: 'Invalid context request.',
        },
      })
    }
    try {
      const context = await resolveAgentContext(
        fastify.db,
        fastify.agentChannel,
        readAgentBearerKey(request.headers.authorization),
        parsedInput.data,
      )
      return reply.code(200).send(context)
    } catch (error: unknown) {
      if (error instanceof AgentUnauthorizedError) {
        return reply.code(401).send({
          error: {
            code: 'unauthorized',
            message: 'Unauthorized agent credential.',
          },
        })
      }
      if (error instanceof AgentBranchNotFoundError) {
        return reply.code(404).send({
          error: {
            code: 'not_found',
            message: 'Branch not found.',
          },
        })
      }
      const failure = contextChannelFailure(error)
      if (failure) {
        if (failure.statusCode >= 500) {
          fastify.log.error({ err: error }, '[Agent] Context snapshot selection failed unexpectedly.')
        }
        return reply.code(failure.statusCode).send({
          error: {
            code: failure.code,
            message: failure.message,
          },
        })
      }
      fastify.log.error({ err: error }, '[Agent] Context resolution failed unexpectedly.')
      return reply.code(500).send({
        error: {
          code: 'internal_error',
          message: 'Internal agent API error.',
        },
      })
    }
  })

  fastify.post(
    '/api/agent/v1/snapshot/manifest/roots',
    {
      bodyLimit: MAX_AGENT_SNAPSHOT_READ_REQUEST_BYTES,
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      if (!isJsonContentType(request.headers['content-type'])) {
        return reply.code(415).send({
          error: {
            code: 'unsupported_media_type',
            message: 'Expected application/json.',
          },
        })
      }
      const parsedInput = AgentSnapshotManifestRootsInputSchema.safeParse(request.body)
      if (!parsedInput.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message: 'Invalid snapshot manifest root request.',
          },
        })
      }
      try {
        const result = await resolveAgentManifestRoots(
          fastify.db,
          fastify.agentChannel,
          readAgentBearerKey(request.headers.authorization),
          parsedInput.data,
        )
        return reply.code(200).send(result)
      } catch (error: unknown) {
        if (error instanceof AgentUnauthorizedError) {
          return reply.code(401).send({
            error: {
              code: 'unauthorized',
              message: 'Unauthorized agent credential.',
            },
          })
        }
        const failure = readFailure(error)
        if (failure.statusCode >= 500) {
          fastify.log.error('[Agent] Snapshot manifest root read failed unexpectedly.')
        }
        return reply.code(failure.statusCode).send({
          error: {
            code: failure.code,
            message: failure.message,
          },
        })
      }
    },
  )

  fastify.post(
    '/api/agent/v1/snapshot/manifest/entries',
    {
      bodyLimit: MAX_AGENT_SNAPSHOT_READ_REQUEST_BYTES,
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      if (!isJsonContentType(request.headers['content-type'])) {
        return reply.code(415).send({
          error: {
            code: 'unsupported_media_type',
            message: 'Expected application/json.',
          },
        })
      }
      const parsedInput = AgentSnapshotManifestEntriesInputSchema.safeParse(request.body)
      if (!parsedInput.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message: 'Invalid snapshot manifest entry request.',
          },
        })
      }
      try {
        const result = await resolveAgentManifestEntries(
          fastify.db,
          fastify.agentChannel,
          readAgentBearerKey(request.headers.authorization),
          parsedInput.data,
        )
        return reply.code(200).send(result)
      } catch (error: unknown) {
        if (error instanceof AgentUnauthorizedError) {
          return reply.code(401).send({
            error: {
              code: 'unauthorized',
              message: 'Unauthorized agent credential.',
            },
          })
        }
        const failure = readFailure(error)
        if (failure.statusCode >= 500) {
          fastify.log.error('[Agent] Snapshot manifest entry read failed unexpectedly.')
        }
        return reply.code(failure.statusCode).send({
          error: {
            code: failure.code,
            message: failure.message,
          },
        })
      }
    },
  )

  fastify.post(
    '/api/agent/v1/snapshot/artifact/content',
    {
      bodyLimit: MAX_AGENT_SNAPSHOT_READ_REQUEST_BYTES,
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      if (!isJsonContentType(request.headers['content-type'])) {
        return reply.code(415).send({
          error: {
            code: 'unsupported_media_type',
            message: 'Expected application/json.',
          },
        })
      }
      const parsedInput = AgentSnapshotArtifactContentRequestSchema.safeParse(request.body)
      if (!parsedInput.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message: 'Invalid snapshot artifact content request.',
          },
        })
      }
      try {
        const result = await resolveAgentArtifactContent(
          fastify.db,
          fastify.agentChannel,
          readAgentBearerKey(request.headers.authorization),
          parsedInput.data,
        )
        return reply.code(200).send(result)
      } catch (error: unknown) {
        if (error instanceof AgentUnauthorizedError) {
          return reply.code(401).send({
            error: {
              code: 'unauthorized',
              message: 'Unauthorized agent credential.',
            },
          })
        }
        const failure = readFailure(error)
        if (failure.statusCode >= 500) {
          fastify.log.error('[Agent] Snapshot artifact content read failed unexpectedly.')
        }
        return reply.code(failure.statusCode).send({
          error: {
            code: failure.code,
            message: failure.message,
          },
        })
      }
    },
  )
}
