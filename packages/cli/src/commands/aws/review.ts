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
    ['Region', proposal.permission.region],
    ...POLICY_KEYS.map((key): DiagnosticFact => [policyLabel(key), describeMode(modes[key], proposal, key)]),
  ]
  for (const key of changed) {
    const { changes, reads } = summarize(proposal.permission.policies[key].document)
    facts.push([`${title(key)} grants`, changes.join(', ')], [`${title(key)} reads`, `${reads} read-only actions`])
  }
  reporter.section('Permission change')
  reporter.facts(facts)
  reporter.space()
  if (changed.length === 0) {
    reporter.info('No IAM change is required. The live policies will be freshly verified.')
    return
  }
  const { instanceType, storage } = AWS_SPEC.compute
  reporter.info(
    'Listed grants are the complete actions of each changed policy document, taken from the exact document that is approved and saved. Region, resource, and tag conditions narrow them.',
  )
  reporter.space()
  reporter.line(
    `- Compute: launch and terminate operator-tagged ${instanceType} On-Demand instances; create ${storage.rootSizeGiB} GiB root and ${storage.dataSizeGiB} GiB data ${storage.volumeType} volumes and attach the data volume; allocate, associate, and release tagged Elastic IPs; import and delete administrative key pairs.`,
  )
  reporter.line(
    '- No volume deletion, detachment, resize, or snapshot authority: a retained data volume must be deleted outside Qiln. No KMS authority and no encryption requirement; account encryption defaults still apply.',
  )
  reporter.line(
    '- VPC deletion authority covers any VPC in this account and region tagged with the operator ARN, qiln:managed-by=qiln-cli, and a nonempty qiln:deployment value, not only one deployment ID.',
  )
  reporter.line(
    '- Deletion authority for subnets, internet gateways, route tables, and security groups covers any such resource in this account and region tagged with the operator ARN, not only one deployment.',
  )
  reporter.line('- Deployment commands do not use compute authority yet. Connect does not create or remove infrastructure.')
  reporter.space()
  reporter.notice(
    'These permissions can be exercised with this operator’s credentials outside Qiln. A deployment record is a Qiln execution gate, not an AWS authorization boundary. Neither policy approves provisioning or spending.',
  )
  reporter.notice('IAM changes are not automatically undone if setup fails.')
}
