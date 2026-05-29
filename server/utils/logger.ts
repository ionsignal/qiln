import pino from 'pino'
import { FastifyBaseLogger } from 'fastify'

const logger: FastifyBaseLogger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'time,pid,hostname,level',
      messageFormat: '[logger] {msg}',
    },
  },
  level: process.env.LOG_LEVEL || 'info',
})

export { logger }
