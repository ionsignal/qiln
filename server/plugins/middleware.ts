import fp from 'fastify-plugin'
import middie from '@fastify/middie'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'

export default fp(
  async fastify => {
    await fastify.register(middie)
    if (!fastify.config.dev) {
      await fastify.register(compress, {
        encodings: ['gzip', 'deflate'],
      })
    }
    await fastify.register(cookie, {
      hook: 'onRequest',
      secret: process.env.FASTIFY_COOKIE_SECRET,
    })
  },
  {
    name: 'middleware',
  },
)
