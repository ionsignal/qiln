import { InstallerError, type DiagnosticFact } from '../../diagnostic/error'
import { describe } from '../../aws/deployment/observe/facts'
import { retained } from '../../aws/deployment/topology'
import { diagnostic } from '../../aws/errors'
import { pendingFacts } from '../../aws/iam/facts'
import { cleanRoot } from '../../aws/iam/lifecycle'
import { removeAuth } from '../../aws/auth/session'
import { withAwsOperation } from '../../aws/root'
import { requireAwsHost } from '../../aws/host'
import { resolveAwsName, type AwsCommandOptions } from '../../input'
import { checkCancellation, Prompts, withCancellation } from '../../terminal/prompts'
import { pendingFailure, reportPermissionMetadata, requireSettledDeployments } from './shared'
import * as connections from '../../aws/connections'
import type { Reporter, TableCell } from '../../terminal/reporter'

export async function disconnect(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const name = resolveAwsName(options)
  await withCancellation(async signal => {
    const prompts = new Prompts(signal, 'qiln aws disconnect', reporter)
    await withAwsOperation(false, async ({ root, connections: store }) => {
      const directory = await connections.open(store, name)
      const connection = await connections.read(directory, name)
      const pending = await connections.pending(directory)
      if (pending?.termination === 'unconfirmed') {
        pendingFailure(pending)
      }
      const identity = connection?.identity ?? pending?.operator
      const settled = identity ? await requireSettledDeployments(root, identity) : []
      const recorded: DiagnosticFact[] = [['Connection', name]]
      if (identity) {
        recorded.push(
          ['Recorded account', identity.accountId],
          ['Recorded IAM user', identity.arn],
          ['Recorded user ID', identity.userId],
        )
      } else if (pending?.accountId) {
        recorded.push(['Recorded account', pending.accountId])
      }
      reporter.section('AWS connection')
      reporter.facts(recorded)
      if (connection) {
        reportPermissionMetadata(reporter, connection)
      }
      if (pending) {
        reporter.section('Pending IAM evidence')
        reporter.facts(pendingFacts(pending))
      }
      if (settled.length > 0) {
        reporter.section('Retained deployment evidence')
        reporter.table(
          ['Deployment', 'Recorded outcome'],
          settled.map((record): TableCell[] => [record.id, describe(record)]),
        )
        reporter.notice('Deployment records remain in protected local state after removal. AWS resources are not deleted.')
      }
      const kept = settled.flatMap(record => retained(record).map(resource => ({ record, resource })))
      if (kept.length > 0) {
        reporter.section('Retained AWS resources')
        reporter.table(
          ['Deployment', 'Kind', 'ID'],
          kept.map(({ record, resource }): TableCell[] => [record.id, resource.kind, resource.id]),
        )
        reporter.notice(
          'Qiln never deletes these resources. They are retained by design and keep incurring charges until they are deleted outside Qiln. Once this connection is removed, Qiln can no longer authenticate to observe them, so keep the deployment ID and these identifiers.',
        )
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
      await prompts.approve(`Remove local connection '${name}' and its evidence`)
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
