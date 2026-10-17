import type { DiagnosticFact } from '../../diagnostic/error'
import type { Proposal } from '../../aws/iam/types'
import { POLICY_KEYS, type PolicyKey, type PolicyMap } from '../../aws/permission/keys'
import { reconciliation, type Mode } from '../../aws/permission/spec'
import { summarize } from '../../aws/permission/summary'
import { AWS_SPEC } from '../../aws/spec'
import type { Reporter } from '../../terminal/reporter'

function title(key: PolicyKey): string {
  return `${key[0].toUpperCase()}${key.slice(1)}`
}

export function policyLabel(key: PolicyKey): string {
  return `${title(key)} policy`
}

export function modesOf(proposal: Proposal): PolicyMap<Mode> {
  return reconciliation(proposal.inspection.before?.policies ?? null, proposal.permission)
}

function describeMode(mode: Mode, proposal: Proposal, key: PolicyKey): string {
  const desired = proposal.permission.policies[key].sha256.slice(0, 12)
  switch (mode) {
    case 'enroll':
      return `create and attach a new customer-managed policy · SHA-256 ${desired}`
    case 'replace': {
      const current = proposal.inspection.before?.policies[key].policy
      const from = current ? `${current.versionId}, SHA-256 ${current.sha256.slice(0, 12)}` : 'unknown version'
      return `new default version replaces ${from} with SHA-256 ${desired}; the prior version stays in IAM history`
    }
    case 'none':
      return 'unchanged; the live policy already matches'
  }
}

/**
 * One disclosure shared by onboarding and permission maintenance. It is shown
 * before the approval that persists mutation authority.
 */
export function reportPermissionChange(reporter: Reporter, proposal: Proposal): void {
  const modes = modesOf(proposal)
  const changed = POLICY_KEYS.filter(key => modes[key] !== 'none')
  const facts: DiagnosticFact[] = [
    ['Operator', proposal.operatorArn],
    ['EC2 permission scope', 'all commercial AWS regions'],
    ['Deployment region', proposal.deploymentRegion],
    ['Default/login region', 'independent of the permission scope; editable by reconnecting and never changes the deployment region'],
    ...POLICY_KEYS.map((key): DiagnosticFact => [policyLabel(key), describeMode(modes[key], proposal, key)]),
  ]
  for (const key of changed) {
    const { changes, reads, launchTypes } = summarize(proposal.permission.policies[key].document)
    facts.push([`${title(key)} grants`, changes.join(', ')], [`${title(key)} reads`, `${reads} read-only actions`])
    if (launchTypes.length > 0) {
      facts.push([`${title(key)} launch types`, `${launchTypes.length} permitted: ${launchTypes.join(', ')}`])
    }
  }
  reporter.section('Permission change')
  reporter.facts(facts)
  reporter.space()
  if (changed.length === 0) {
    reporter.info('No IAM change is required. The live policies will be freshly verified.')
    return
  }
  const { volumes } = AWS_SPEC.permission
  reporter.info(
    'Listed grants are the complete actions of each changed policy document, taken from the exact document that is approved and saved. Resource and tag conditions narrow them; EC2 resources are matched in every commercial AWS region and read actions carry no region restriction.',
  )
  reporter.space()
  reporter.line(
    `- Compute: launch operator-tagged On-Demand instances of the listed launch types only; terminate operator-tagged instances of any type; create ${volumes.types.join(', ')} volumes within the volume ceilings and attach the data volume; allocate, associate, and release tagged Elastic IPs; import and delete administrative key pairs.`,
  )
  reporter.line(
    `- Volume ceilings per request: launch-created (root) volume up to ${volumes.maximumRootGiB} GiB, data volume up to ${volumes.maximumDataGiB} GiB, and each up to ${volumes.maximumIops} IOPS and ${volumes.maximumThroughput} MiB/s. They limit individual requests, not aggregate storage or spending. Each deployment approves and retains its exact volume settings, so changing deployment defaults within these ceilings needs no permission review.`,
  )
  reporter.line(
    '- Launch types are permission scope only. Each deployment approves and retains its exact type, and catalog membership establishes no AMI compatibility, GPU capability, regional offering, or capacity.',
  )
  reporter.line(
    '- No volume deletion, detachment, resize, or snapshot authority: a retained data volume must be deleted outside Qiln. No KMS authority and no encryption requirement; account encryption defaults still apply.',
  )
  reporter.line(
    '- VPC deletion authority covers any VPC in this account, in any commercial region, tagged with the operator ARN, qiln:managed-by=qiln-cli, and a nonempty qiln:deployment value, not only one deployment ID.',
  )
  reporter.line(
    '- Deletion authority for subnets, internet gateways, route tables, and security groups covers any such resource in this account, in any commercial region, tagged with the operator ARN, not only one deployment.',
  )
  reporter.line('- Connect does not create or remove infrastructure.')
  reporter.space()
  reporter.notice(
    'These permissions can be exercised with this operator’s credentials outside Qiln, in any commercial AWS region. The recorded deployment region is a Qiln execution gate, not an AWS regional authorization boundary. All-region authority does not enable opt-in regions or establish service availability. Neither policy approves provisioning or spending.',
  )
  reporter.notice('IAM changes are not automatically undone if setup fails.')
}
