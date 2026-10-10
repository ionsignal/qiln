import type { InstallerErrorCode } from '../../diagnostic/error'
import type { ChildReply, Failure } from './protocol'

export interface ChildService<Request, Result, Code extends InstallerErrorCode> {
  isRequest(message: unknown): message is Request
  execute(request: Request): Promise<Result>
  classify(error: unknown): Failure<Code>
  /** Reported as a rejection when the parent's first message is not an allowlisted request. */
  invalidRequest: Code
}

function reply(message: ChildReply<unknown, InstallerErrorCode>): void {
  if (!process.send || !process.connected) {
    process.exit(1)
  }
  process.send(message, error => {
    // The IPC callback runs after transmission. No credentials or provider
    // context survive into another request.
    process.exit(error ? 1 : 0)
  })
}

/**
 * Serves exactly one request and exits. Call only from a child entry file;
 * importing this module has no side effects.
 */
export function serveChild<Request, Result, Code extends InstallerErrorCode>(
  service: ChildService<Request, Result, Code>,
): void {
  if (!process.send) {
    process.exitCode = 1
    return
  }
  const handle = async (message: unknown): Promise<void> => {
    if (!service.isRequest(message)) {
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
        result: await service.execute(message),
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
