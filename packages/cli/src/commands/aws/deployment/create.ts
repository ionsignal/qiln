import { AWS_SPEC } from '../../../aws/spec'
import { POLICY_KEYS, enrolledKeys } from '../../../aws/permission/keys'
import { findPin } from '../../../aws/ami'
import { Session } from '../../../aws/auth/session'
import { requireEnvelope } from '../../../aws/permission/envelope'
import { deploymentName } from '../../../aws/deployment/alias'
import { requireBound } from '../../../aws/deployment/binding'
import { validSource } from '../../../aws/deployment/cidr'
import { Deployer, propose } from '../../../aws/deployment/deployer'
import { expectation, matches } from '../../../aws/deployment/expect'
import { evaluate, isBlocked } from '../../../aws/deployment/proposal/evaluate'
import { prepare } from '../../../aws/deployment/proposal/prepare'
import { reusable, type Reuse } from '../../../aws/deployment/reuse'
import { requireStorageReleased } from '../../../aws/deployment/incus/facts'
import { requirePoolReleased } from '../../../aws/deployment/zfs/facts'
import { reviewRequired } from '../../../aws/permission/spec'
import { requireAwsHost } from '../../../aws/host'
import { requireKeygen } from '../../../aws/ssh/generate'
import { Prompts, withCancellation } from '../../../terminal/prompts'
import { InstallerError } from '../../../diagnostic/error'
import { resolveAwsName, type AwsDeploymentCreateOptions } from '../../../input'
import { authenticate, reportAuthentication, requireAvailable, withConfirmedOperation } from '../shared'
import { reportCreationEffects, reportProposal } from './preview'
import { progressSink } from './progress'
import { observationSummary, reportDeployment } from './report'
import { evidence as incusEvidence } from '../../../aws/deployment/incus/evidence'
import * as deployments from '../../../aws/deployment/records'
import * as connections from '../../../aws/connection/records'
import * as lineage from '../../../aws/deployment/zfs/lineage'
import type { Dir } from '../../../state/files'
import type { Deployment } from '../../../aws/deployment/types'
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
 * Reuse is offered for approval only after a fresh read of the previous
 * deployment agrees with its record, which includes the retained volume being
 * available and unattached with its recorded configuration and tags. This is
 * the existing inspect path, so it needs no new child request or permission.
 */
async function requireVolumeAvailable(
  root: Dir,
  session: Session,
  previous: Deployment,
  reuse: Reuse,
  signal: AbortSignal,
): Promise<void> {
  const deployer = Deployer.open(root, session, previous)
  const observation = await deployer.observe(signal)
  if (!matches(expectation(deployer.record), observation)) {
    throw new InstallerError({
      code: 'AWS_DEPLOYMENT_REUSE_REFUSED',
      facts: [
        ['Previous deployment', previous.id],
        ['Volume', reuse.volumeId],
        ['Observed resources', observationSummary(observation)],
      ],
      retry: `qiln aws deployment inspect --id ${previous.id}`,
    })
  }
}

/**
 * Provisions one approved host. Discovery and evaluation are read-only, and
 * nothing is saved, reserved, generated, or created until the single approval.
 * When the alias takes over a removed deployment that retained its data volume,
 * the operator explicitly chooses between a new volume and reusing that one;
 * the choice is part of the same approval. After it, the immutable approval is
 * retained and the fenced creation steps and the AWS health read run under the
 * operation lock. Success establishes AWS provisioning and health only; create
 * makes no SSH connection to the instance.
 */
export async function create(options: AwsDeploymentCreateOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  requireEnvelope()
  const name = resolveAwsName(options)
  const retry = `qiln aws deployment create --name ${name} --alias ${options.alias}`
  const message = await withCancellation(async signal => {
    const prompts = new Prompts(signal, 'qiln aws deployment create', reporter)
    return await withConfirmedOperation(false, async ({ root, connections: store }) => {
      const previous = await deployments.predecessor(root, options.alias)
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
      const pin = findPin(managed.deploymentRegion)
      if (pin === null) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_IMAGE_NOT_INDEXED',
          facts: [
            ['Deployment region', managed.deploymentRegion],
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
      const offer = previous === null ? null : reusable(previous)
      let reuse: Reuse | null = null
      if (offer !== null) {
        reporter.notice(
          'Incus preparation cannot initialize a reused pool that holds retained Incus datasets, because restoration is not supported. Choose a new data volume if Incus is required.',
        )
        const choice = await prompts.select('Data storage', [
          'Create a new data volume',
          `Reuse ${offer.volumeId} from the previously removed deployment`,
        ])
        reuse = choice === 1 ? offer : null
      }
      if (previous !== null && reuse !== null) {
        requirePoolReleased(await lineage.evidence(root, previous), previous.id)
        requireStorageReleased(await incusEvidence(root, previous), previous.id)
      }
      const session = await Session.open(directory, connection.region)
      const authentication = await authenticate(session, connection.identity, signal)
      reporter.section('AWS authentication')
      reportAuthentication(reporter, authentication)
      if (previous !== null && reuse !== null) {
        requireBound(connection, previous)
        await requireVolumeAvailable(root, session, previous, reuse, signal)
        reporter.section('Retained data volume')
        reporter.row(
          'verified',
          'Volume',
          `${reuse.volumeId} from deployment ${previous.id} · fresh observation agrees with the record · available and unattached`,
        )
      }
      const discovery = await prepare(session, signal)
      const proposal = evaluate(discovery, { region: managed.deploymentRegion, administrator, pin, reuse })
      reportProposal(reporter, proposal, {
        alias: options.alias,
        identity: connection.identity,
        previous: previous?.id ?? null,
      })
      if (isBlocked(proposal)) {
        throw new InstallerError({
          code: 'AWS_DEPLOYMENT_PREREQUISITES_BLOCKED',
          facts: [
            ['Deployment region', proposal.region],
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
      reportCreationEffects(reporter, plan, proposal.reuse)
      await prompts.approve('Approve the displayed host and create its AWS resources')
      const deployer = await Deployer.approve(
        root,
        session,
        propose(connection, plan, options.alias, previous?.id ?? null, proposal.reuse),
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
