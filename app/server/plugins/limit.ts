import fp from 'fastify-plugin'
import fastifyRateLimit from '@fastify/rate-limit'
import { FastifyPluginAsync } from 'fastify'

const rateLimitPlugin: FastifyPluginAsync = async fastify => {
  const limitConfig = fastify.config.limit

  // TODO: maybe implement shared store?
  // import Redis from 'ioredis';
  // import RateLimitRedisStore from '@fastify/rate-limit-redis';
  // const redisClient = new Redis(...); // Your Redis connection
  // const store = new RateLimitRedisStore({
  //   client: redisClient,
  //   // ... other store options
  // });

  await fastify.register(fastifyRateLimit, {
    global: limitConfig.global, // Use global setting from config
    max: limitConfig.max, // Max requests per timeWindow from config
    timeWindow: limitConfig.timeWindow, // Time window from config
    // keyGenerator: (request) => request.ip, // Default uses request.ip
    // store: store, // Uncomment and configure for production Redis store
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true, // For fixed window or Redis store
      'retry-after': true, // Recommended for 429 responses
    },
    // errorResponseBuilder: (request, context) => { ... }
  })
  fastify.log.info(
    {
      global: limitConfig.global,
      max: limitConfig.max,
      timeWindow: limitConfig.timeWindow,
    },
    'Registered @fastify/rate-limit plugin',
  )
}

export default fp(rateLimitPlugin, {
  name: 'rate-limit',
  dependencies: [],
})
