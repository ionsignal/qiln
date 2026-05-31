import type { FastifyInstance } from 'fastify'

/**
 * Provides a basic health check endpoint for load balancers.
 * Ensures the `routes` directory exists for @fastify/autoload.
 */
export default async function (fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    }
  })
}