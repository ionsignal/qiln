import { InstallerError } from '../../diagnostic/error'
import { reviewRequired } from '../../aws/permission/spec'
import { pendingFacts } from '../../aws/iam/facts'
import { Session } from '../../aws/auth/session'
import { requireAwsHost } from '../../aws/host'
import { checkCancellation, withCancellation } from '../../terminal/prompts'
import {
  authenticate,
  failAuthentication,
  pendingFailure,
  reportAuthentication,
  reportPermissionMetadata,
  withConfirmedOperation,
} from './shared'
import * as connections from '../../aws/connection/records'
import type { Reporter } from '../../terminal/reporter'
import type { AwsAuthentication } from '../../aws/types'
import type { AwsCommandOptions } from '../../input'

export async function status(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  await withCancellation(async signal => {
    await withConfirmedOperation(false, async ({ connections: store }) => {
      const names = options.name === undefined ? await connections.names(store) : [options.name]
      if (names.length === 0) {
        reporter.summary('No Qiln AWS connections are saved.')
      }
      for (const name of names) {
        checkCancellation(signal)
        const directory = await connections.open(store, name)
        const pending = await connections.pending(directory)
        if (pending?.termination === 'unconfirmed') {
          pendingFailure(pending)
        }
        const connection = await connections.read(directory, name)
        if (!connection) {
          if (pending) {
            pendingFailure(pending)
          }
          throw new InstallerError({
            code: 'AWS_CONNECTION_INCOMPLETE',
            facts: [['Connection', name]],
            retry: `qiln aws connect --name ${name}`,
          })
        }
        reporter.section(name)
        const session = await Session.open(directory, connection.region)
        let authentication: AwsAuthentication
        try {
          authentication = await authenticate(session, connection.identity, signal)
        } catch (error: unknown) {
          if (error instanceof InstallerError && error.code === 'AWS_ROOT_REFUSED') {
            return await failAuthentication(directory, name, error)
          }
          throw error
        }
        reportAuthentication(reporter, authentication)
        reporter.row('verified', 'Default/login region', connection.region)
        reportPermissionMetadata(reporter, connection)
        if (reviewRequired(connection)) {
          reporter.notice('Current permission requirements need a renewed root review. Reconnect to offer that review.')
        }
        if (pending) {
          reporter.notice('An IAM operation requires explicit recovery. The saved operator login remains separate.')
          for (const [label, value] of pendingFacts(pending)) {
            reporter.info(`${label}: ${value}`)
          }
        }
        reporter.info('This status check did not freshly inspect IAM or assess deployment readiness.')
      }
    })
  })
}
