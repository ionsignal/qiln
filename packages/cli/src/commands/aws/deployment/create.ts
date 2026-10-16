import { findPin } from '../../../aws/ami'
import { POLICY_KEYS, enrolledKeys } from '../../../aws/permission/keys'
import { Session } from '../../../aws/auth/session'
import { deploymentName } from '../../../aws/deployment/alias'
import { validSource } from '../../../aws/deployment/cidr'
import { Deployer, propose } from '../../../aws/deployment/deployer'
import { evaluate, isBlocked } from '../../../aws/deployment/proposal/evaluate'
import { prepare } from '../../../aws/deployment/proposal/prepare'
import { reviewRequired } from '../../../aws/permission/spec'
import { requireAwsHost } from '../../../aws/host'
import { requireKeygen } from '../../../aws/ssh/generate'
import { AWS_SPEC } from '../../../aws/spec'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { InstallerError } from '../../../diagnostic/error'
import { resolveAwsName, type AwsDeploymentCreateOptions } from '../../../input'
import { authenticate, reportAuthentication, requireAvailable, withConfirmedOperation } from '../shared'
import { reportCreationEffects, reportProposal } from './preview'
import { progressSink } from './progress'
import { reportDeployment } from './report'
import * as deployments from '../../../aws/deployment/records'
import * as connections from '../../../aws/connection/records'
import type { AwsConnection, ManagedOperator } from '../../../aws/types'
import type { Reporter } from '../../../terminal/reporter'

function requireCurrentPermissions(connection: AwsConnection): ManagedOperator {
  const managed = connection.managed
  if (!managed || reviewRequired(connection)) {
    const enrolled = managed ? enrolledKeys(managed.policies) : []
    const missing = POLICY_KEYS.filter(key => !enrolled.includes(key))
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_PERMISSION_REQUIRED',
      facts: [
        ['Connection', connection.name],
        ['Managed operator', managed ? 'qiln-created' : 'authentication-only'],
        ['Enrolled policies', enrolled.join(', ') || 'none'],
        ['Missing policies', missing.join(', ') || 'none'],
        ['Last verification', managed?.verified.verifiedAt ?? 'none recorded'],
      ],
      retry: `qiln aws connect --name ${connection.name}`,
    })
  }
  return managed
}

/**
 * Provisions one approved GPU host. Discovery and evaluation are read-only, and
 * nothing is saved, reserved, generated, or created until the single approval.
 * After it, the immutable approval is retained and the fenced creation steps
 * and the AWS health read run under the operation lock. Success establishes
 * AWS provisioning and health only; Qiln never connects to the instance.
 */
export async function create(options: AwsDeploymentCreateOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const name = resolveAwsName(options)
  const retry = `qiln aws deployment create --name ${name} --alias ${options.alias}`
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, 'qiln aws deployment create', reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      // A taken alias is refused early so the operator does not review a
      // proposal that could not be approved. The record write checks it again.
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
      const managed = requireCurrentPermissions(connection)
      // An unindexed region stops here, before any prompt, authentication, or
      // AWS read. The credential child resolves the same entry on its own.
      const pin = findPin(managed.permissionRegion)
      if (pin === null) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_IMAGE_NOT_INDEXED',
          facts: [
            ['Permission region', managed.permissionRegion],
            ['Reviewed release', AWS_SPEC.compute.image.name],
          ],
        })
      }
      // Checked before approval, so a missing tool cannot strand an approved record.
      await requireKeygen()
      // Asked before authentication so invalid input fails without any AWS read.
      const administrator = await prompts.text('Administrator IPv4 network for SSH (for example 203.0.113.7/32)')
      if (!validSource(administrator)) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_INGRESS_INVALID',
          retry,
        })
      }
      const session = await Session.open(directory, connection.region)
      const authentication = await authenticate(session, connection.identity, signal)
      reporter.section('AWS authentication')
      reportAuthentication(reporter, authentication)
      const discovery = await prepare(session, signal)
      const proposal = evaluate(discovery, { region: managed.permissionRegion, administrator, pin })
      reportProposal(reporter, proposal, { alias: options.alias, identity: connection.identity })
      if (isBlocked(proposal)) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_PREREQUISITES_BLOCKED',
          facts: [
            ['Region', proposal.region],
            ['Blockers', String(proposal.findings.filter(finding => finding.severity === 'blocker').length)],
          ],
          retry,
        })
      }
      const plan = proposal.plan
      if (plan === null) {
        throw new InstallerError({
          code: 'INTERNAL_ERROR',
          retry,
        })
      }
      reportCreationEffects(reporter, plan)
      await prompts.approve('Approve the displayed GPU host and create its AWS resources')
      const deployer = await Deployer.approve(
        root,
        session,
        propose(connection, plan, options.alias),
        progressSink(reporter),
      )
      reporter.space()
      reporter.row(
        'created',
        'Approval record',
        `${deploymentName(options.alias)} · ${deployer.record.id} · saved locally; no AWS resource exists yet`,
      )
      await deployer.create(signal)
      reportDeployment(reporter, deployer.record)
      return 'AWS provisioning and health verified. Billable resources remain until removed. This is not SSH access, guest compatibility, or readiness.'
    })
  })
  reporter.summary(message)
}
