import { AgentGetContextInputSchema } from '@qiln/core/server'
import { AgentBranchNotFoundError, AgentUnauthorizedError, resolveAgentContext } from '@server/agent/context'
import { readAgentBearerKey } from '@server/agent/key'
import type { FastifyInstance } from 'fastify'

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

/**
 * External agent access is intentionally separate from browser sessions and
 * tRPC. This route derives all authority from a host-owned API credential.
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
}
