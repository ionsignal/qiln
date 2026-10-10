import { InstallerError } from '../../diagnostic/error'
import * as connections from '../../aws/connection/records'
import { diagnostic } from '../../aws/errors'
import { pendingFacts } from '../../aws/iam/facts'
import { cleanRoot } from '../../aws/iam/lifecycle'
import { removeAuth } from '../../aws/auth/session'
import { withAwsState } from '../../aws/connection/store'
import { requireAwsHost } from '../../aws/host'
import { resolveAwsName, type AwsCommandOptions } from '../../input'
import { checkCancellation, Prompts, withCancellation } from '../../terminal/prompts'
import type { Reporter } from '../../terminal/reporter'
import { pendingFailure, reportPermissionMetadata } from './shared'

export async function disconnect(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const name = resolveAwsName(options)
  await withCancellation(async signal => {
    const prompts = new Prompts(signal, 'qiln aws disconnect', reporter)
    await withAwsState(false, async store => {
      const directory = await connections.open(store, name)
      const connection = await connections.read(directory, name)
      const pending = await connections.pending(directory)
      if (pending?.termination === 'unconfirmed') {
        pendingFailure(pending)
      }
      reporter.section('AWS connection')
      reporter.row('verified', 'Connection', name)
      const identity = connection?.identity ?? pending?.operator
      if (identity) {
        reporter.row('verified', 'Recorded account', identity.accountId)
        reporter.row('verified', 'Recorded IAM user', identity.arn)
        reporter.row('verified', 'Recorded user ID', identity.userId)
      } else if (pending?.accountId) {
        reporter.row('verified', 'Recorded account', pending.accountId)
      }
      if (connection) {
        reportPermissionMetadata(reporter, connection)
      }
      if (pending) {
        reporter.section('Pending IAM evidence')
        for (const [label, value] of pendingFacts(pending)) {
          reporter.info(`${label}: ${value}`)
        }
      }
      if (connection?.managed || pending) {
        reporter.notice(
          'Local removal discards resource bindings, approval, and recovery evidence. Inspect or retain that evidence before approving removal.',
        )
        reporter.notice(
          'IAM users, passwords, MFA devices, policies, and retained versions remain. An unresolved IAM mutation may already have completed.',
        )
      }
      reporter.notice('Credentials already loaded elsewhere can remain usable until expiration.')
      reporter.info(
        'Only this validated current-layout connection and its local authentication and pending evidence are removed. Shared tools and AWS resources remain.',
      )
      await prompts.approve(`Remove local AWS connection '${name}' and its disclosed evidence`)
      checkCancellation(signal)
      try {
        await removeAuth(directory)
        if (pending) {
          await cleanRoot(directory, pending.id)
        }
        await connections.remove(store, name)
      } catch (error: unknown) {
        const failure = diagnostic(error)
        throw new InstallerError({
          code: failure.code,
          facts: [
            ...failure.facts,
            ...(pending ? pendingFacts(pending) : []),
            [
              'Local removal',
              'Removal or directory synchronization was not confirmed. No AWS resource deletion or rollback was attempted.',
            ],
          ],
          retry: `qiln aws disconnect --name ${name}`,
        })
      }
    })
  })
  reporter.summary(`Local AWS connection '${name}' removed. Shared tools and AWS resources retained.`)
}
