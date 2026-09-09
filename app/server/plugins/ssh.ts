import fp from 'fastify-plugin'
import { SshControlClient } from '@server/ssh'

export default fp(
  async fastify => {
    fastify.decorate('ssh', new SshControlClient(fastify.channel))
  },
  {
    name: 'ssh',
    dependencies: ['capsule-channel'],
  },
)
