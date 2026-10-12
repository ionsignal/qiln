import { Session } from '../../../aws/auth/session'
import { InstallerError, type DiagnosticFact } from '../../../diagnostic/error'
import { deploymentName } from '../../../aws/deployment/alias'
import { Deployer, placement, propose } from '../../../aws/deployment/deployer'
import * as deployments from '../../../aws/deployment/records'
import { creationPlan } from '../../../aws/deployment/topology'
import { reviewRequired } from '../../../aws/foundation/requirement'
import { requireAwsHost } from '../../../aws/host'
import { resolveAwsName, type AwsDeploymentCreateOptions } from '../../../input'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { authenticate, reportAuthentication, requireAvailable, withConfirmedOperation } from '../shared'
import { reportDeployment } from './report'
import * as connections from '../../../aws/connection/records'
import type { AwsConnection } from '../../../aws/types'
import type { Reporter } from '../../../terminal/reporter'
import type { Deployment } from '../../../aws/deployment/types'

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
  const { approval, binding } = proposal
  reporter.section('Proposed network — not yet created')
  reporter.facts([
    ['Name', deploymentName(proposal.alias)],
    ['Region', binding.region],
    ['VPC CIDR', approval.cidr],
    ['Tenancy', approval.tenancy],
    ...approval.zones.map((zone): DiagnosticFact => ['Subnet', `${zone.name} (${zone.id}) · ${zone.cidr}`]),
    ...approval.ingress.map((rule): DiagnosticFact => ['Ingress', `tcp ${rule.port} from ${rule.cidr}`]),
    ...approval.tags.map((tag): DiagnosticFact => ['Tag', `${tag.Key}=${tag.Value}`]),
  ])
  reporter.space()
  reporter.info(
    'Creates one VPC, one subnet per listed Availability Zone, one internet gateway attached to the VPC, one route table that sends 0.0.0.0/0 to the gateway and is associated with every subnet, and one security group for the host.',
  )
  reporter.info(
    `Creation runs ${creationPlan(approval).length} provider calls, each followed by an observation of the recorded network. Ports 80 and 443 are open to the internet; SSH is limited to the displayed administrator network.`,
  )
  reporter.info(
    "The security group keeps AWS's initial allow-all IPv4 egress rule. No public addresses, instances, Elastic IPs, NAT gateways, IPv6, load balancers, storage, or spending are approved or created.",
  )
  reporter.info(
    "AWS also adds a main route table, a default security group and network ACL, and a default DHCP options association to every VPC. Qiln neither modifies nor observes them.",
  )
  reporter.info(
    'The VPC CIDR is pinned by this Qiln release and the zones are frozen now. Once approved, the record alone governs every later command for this deployment.',
  )
  reporter.info(
    'The name is a local alias only; it is not an AWS tag. Creation calls have no idempotency token and never resume. An uncertain outcome is never repeated: clean up a stopped creation with remove, and a new create is a new deployment.',
  )
  reporter.space()
  reporter.notice(
    'Completion establishes only the observed network outcome and retained evidence, not public reachability, working HTTPS or SSH, launch authority, capacity, Ubuntu compatibility, deployment readiness, or rollback.',
  )
}

export async function create(options: AwsDeploymentCreateOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const name = resolveAwsName(options)
  const created = await withCancellation(async signal => {
    const prompts = new Prompts(signal, 'qiln aws deployment create', reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      // An early check spares the operator authentication and the prompt; the
      // record store repeats it under the lock when the approval is saved.
      await deployments.requireFreeAlias(root, options.alias)
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
      const authentication = await authenticate(session, connection.identity, signal)
      reporter.section('AWS authentication')
      reportAuthentication(reporter, authentication)
      const zones = await placement(session, signal)
      const administrator = await prompts.text('Administrator IPv4 network for SSH (for example 203.0.113.7/32)')
      const proposal = propose(connection, zones, administrator, options.alias)
      reportProposal(reporter, proposal)
      await prompts.approve('Create the displayed network')
      const deployer = await Deployer.approve(root, session, proposal)
      await deployer.create(signal)
      reportDeployment(reporter, deployer.record)
      return deployer.record
    })
  })
  reporter.summary(
    `Network created and observed as ${deploymentName(created.alias)} (${created.id}). It remains until removed.`,
  )
}
