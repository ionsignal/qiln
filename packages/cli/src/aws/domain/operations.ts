import { InstallerError } from '../../diagnostic/error'
import { armDispatch } from '../child/dispatch'
import { authenticate, locate } from '../child/context'
import { requireBound } from '../deployment/binding'
import { subjectOf } from './subject'
import { issue, register } from './client'
import { childDeadlineMs, type Request, type Result } from './protocol'
import * as connections from '../connections'
import * as deployments from '../deployment/records'

function notAttempted(): never {
  throw new InstallerError({
    code: 'DOMAIN_NOT_ATTEMPTED',
  })
}

/**
 * Execution authority is reloaded from durable evidence: the parent-held lock,
 * the bound connection, the authenticated identity, and the subject that the
 * deployment records. Nothing about the installation comes from the request.
 */
export async function execute(request: Request): Promise<Result> {
  armDispatch()
  const signal = AbortSignal.timeout(childDeadlineMs(request))
  const { root, name, directory } = await locate(notAttempted)
  const record = await deployments.read(root, request.deploymentId)
  if (!record || record.connection !== name) {
    return notAttempted()
  }
  const connection = requireBound(await connections.read(directory, name), record)
  const credentials = await authenticate(connection.region, record.binding.operator, signal, notAttempted)
  const { installation, address } = await subjectOf(root, record)
  switch (request.kind) {
    case 'register':
      return { kind: 'registered', ...(await register(credentials, signal, installation, address)) }
    case 'issue':
      return { kind: 'issued', ...(await issue(credentials, signal, installation, request.csr)) }
  }
}
