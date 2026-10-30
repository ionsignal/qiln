import type { z } from 'zod'
import type { InstallerErrorCode } from '../../diagnostic/error'
import { accept } from '../primitives'
import type { ChildReply, Failure } from './protocol'

export interface ChildService<S extends z.ZodType, Result, Code extends InstallerErrorCode> {
  requestSchema: S
  execute(request: z.output<S>): Promise<Result>
  classify(error: unknown): Failure<Code>
  invalidRequest: Code
}

function reply(message: ChildReply<unknown, InstallerErrorCode>): void {
  if (!process.send || !process.connected) {
    process.exit(1)
  }
  process.send(message, error => {
    process.exit(error ? 1 : 0)
  })
}

/**
 * Serves exactly one request and exits. Call only from a child entry file;
 * importing this module has no side effects.
 */
export function serveChild<S extends z.ZodType, Result, Code extends InstallerErrorCode>(
  service: ChildService<S, Result, Code>,
): void {
  if (!process.send) {
    process.exitCode = 1
    return
  }
  const handle = async (message: unknown): Promise<void> => {
    const request = accept(service.requestSchema, message)
    if (request === null) {
      reply({
        ok: false,
        code: service.invalidRequest,
        certainty: 'rejected',
      })
      return
    }
    try {
      reply({
        ok: true,
        result: await service.execute(request),
      })
    } catch (error: unknown) {
      reply({
        ok: false,
        ...service.classify(error),
      })
    }
  }
  process.umask(0o077)
  process.once('disconnect', () => process.exit(1))
  process.once('message', (message: unknown) => {
    void handle(message)
  })
}
