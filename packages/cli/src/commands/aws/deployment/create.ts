import { InstallerError } from '../../../diagnostic/error'
import * as connections from '../../../aws/connection/records'
import { Session } from '../../../aws/auth/session'
import { Deployer, propose } from '../../../aws/deployment/deployer'
import type { Deployment } from '../../../aws/deployment/types'
import { reviewRequired } from '../../../aws/foundation/requirement'
import { requireAwsHost } from '../../../aws/host'
import { withAwsOperation } from '../../../aws/root'
import { AWS_SPEC } from '../../../aws/spec'
import type { AwsConnection } from '../../../aws/types'
import { resolveAwsName, type AwsCommandOptions } from '../../../input'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import type { Reporter } from '../../../terminal/reporter'
import { authenticate, requireAvailable } from '../shared'
import { reportDeployment } from './shared'

/** Creation needs the current requirement, unlike removal, which relies on its own record. */
function requireCurrentPermissions(connection: AwsConnection): void {
  const managed = connection.managed
  if (!managed?.foundation || !managed.verified || reviewRequired(connection)) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_PERMISSION_REQUIRED',
      facts: [
        ['Connection', connection.name],
        ['Managed operator', managed ? 'Qiln-created' : 'authentication-only'],
        ['Foundation policy', managed?.foundation?.arn ?? 'not enrolled'],
        ['Last verification', managed?.verified?.verifiedAt ?? 'none recorded'],
      ],
      retry: `qiln aws connect --name ${connection.name}`,
    })
  }
}

function reportProposal(reporter: Reporter, proposal: Deployment): void {
  reporter.section('AWS VPC deployment')
  reporter.row('verified', 'Account', proposal.binding.accountId)
  reporter.row('verified', 'Operator', proposal.binding.operator.arn)
  reporter.row('verified', 'User identity', proposal.binding.operator.userId)
  reporter.row('verified', 'Region', proposal.binding.region)
  reporter.row('verified', 'CIDR', proposal.approval.cidr)
  reporter.row('verified', 'Tenancy', proposal.approval.tenancy)
  for (const tag of proposal.approval.tags) {
    reporter.row('verified', 'Tag', `${tag.Key}=${tag.Value}`)
  }
  reporter.space()
  reporter.info('Creates exactly one VPC. No subnets, instances, gateways, storage, or spending are approved or created.')
  reporter.info(
    'AWS adds a main route table, a default security group and network ACL, and a default DHCP options association to every VPC.',
  )
  reporter.info(
    'The CIDR is pinned by this Qiln release and cannot be changed here. Once approved, the record alone governs every later command for this deployment.',
  )
  reporter.info(
    'Creation has no idempotency token. An uncertain outcome is never repeated; a new create is a new deployment.',
  )
  reporter.space()
  reporter.notice(
    'Completion establishes only the observed VPC outcome and retained evidence, not launch authority, capacity, SSH access, Ubuntu compatibility, deployment readiness, or rollback.',
  )
  reporter.space()
}

export async function create(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const name = resolveAwsName(options)
  const deploymentId = await withCancellation(async signal => {
    const prompts = new Prompts(signal, 'qiln aws deployment create', reporter)
    return await withAwsOperation(false, async ({ root, connections: store }) => {
      const directory = await connections.open(store, name)
      await requireAvailable(directory)
      const connection = await connections.read(directory, name)
      if (!connection) {
        throw new InstallerError({
          code: 'AWS_CONNECTION_INCOMPLETE',
          facts: [['Connection', name]],
          retry: `qiln aws connect --name ${name}`,
        })
      }
      requireCurrentPermissions(connection)
      const session = await Session.open(directory, connection.region)
      await authenticate(session, connection.identity, signal)
      // Proposing validates the pinned CIDR before any state is written.
      const proposal = propose(connection, AWS_SPEC.deployment.defaultCidr)
      reportProposal(reporter, proposal)
      await prompts.approve('Create the displayed VPC')
      const deployer = await Deployer.approve(root, session, proposal)
      await deployer.create(signal)
      reportDeployment(reporter, deployer.record)
      return deployer.record.id
    })
  })
  reporter.info(`Review the retained evidence with: qiln aws deployment status --id ${deploymentId}`)
  reporter.summary('AWS VPC created and verified; deployment evidence retained.')
}
