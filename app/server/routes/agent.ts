import {
  AgentGetContextInputSchema,
  AgentSnapshotReadInputSchema,
  CapsuleChannelError,
  CapsuleChannelErrorCode,
  MAX_AGENT_SNAPSHOT_READ_REQUEST_BYTES,
} from '@qiln/core/server'
import { AgentArtifactContentDeniedError, AgentSnapshotNotFoundError, resolveAgentRead } from '@server/agent/read'
import { AgentBranchNotFoundError, AgentUnauthorizedError, resolveAgentContext } from '@server/agent/context'
import { readAgentBearerKey } from '@server/agent/key'
import type { FastifyInstance } from 'fastify'

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
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
      fastify.log.error('[Agent] Context resolution failed unexpectedly.')
      return reply.code(500).send({
        error: {
          code: 'internal_error',
          message: 'Internal agent API error.',
        },
      })
    }
  })

  fastify.post(
    '/api/agent/v1/read',
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
      const parsedInput = AgentSnapshotReadInputSchema.safeParse(request.body)
      if (!parsedInput.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message: 'Invalid snapshot read request.',
          },
        })
      }
      try {
        const result = await resolveAgentRead(
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
          fastify.log.error('[Agent] Snapshot read failed unexpectedly.')
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
