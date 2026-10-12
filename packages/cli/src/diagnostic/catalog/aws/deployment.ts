import { entry } from '../define'

export const awsDeploymentDiagnostics = Object.freeze({
  AWS_DEPLOYMENT_STATE_INVALID: entry(
    'AWS deployment evidence is unsafe or incompatible',
    'Deployment records must retain their exact supported schema, ownership, permissions, and recorded bindings. A missing, incomplete, or inconsistent record does not establish that no resource effects occurred, and evidence is never repaired, adopted, or discarded automatically.',
    'Inspect the protected AWS deployments directory and the affected deployment record.',
    'Do not delete deployment evidence or remove locks while another Qiln process may be active.',
    'Compare actual AWS resources with the recorded account, operator, region, and deployment tag before any manual recovery.',
  ),
  AWS_DEPLOYMENT_NOT_FOUND: entry(
    'AWS deployment record was not found',
    'No deployment with this ID exists in protected local state. Qiln does not search by connection, resource ID, or tag, and never adopts an AWS resource that it did not record.',
    'Use the deployment ID printed by qiln aws deployment create.',
    'If the state location changed, restore the original HOME or XDG_STATE_HOME. Deployment records survive local disconnect.',
  ),
  AWS_DEPLOYMENT_PERMISSION_REQUIRED: entry(
    'AWS deployment requires current verified permissions',
    'Creating a deployment requires a Qiln-created operator with an enrolled foundation policy and a recorded verification that matches the current permission requirement. Authentication success and older metadata do not establish current permissions, and this requirement does not approve spending.',
    'Run qiln aws connect with the same connection name and approve the root permission review. A connection verified under an earlier requirement needs a replace-foundation review, which adds creation and deletion authority for Qiln-tagged VPC networking resources.',
    'Arbitrary existing IAM users remain authentication-only and cannot create deployments.',
  ),
  AWS_DEPLOYMENT_PLACEMENT_UNSUPPORTED: entry(
    'AWS Availability Zone placement is unsupported',
    'Placement requires between one and six standard Availability Zones in the permission region, each reporting available. Qiln never skips, chooses among, or substitutes zones, and no network resource was created.',
    'Inspect the Availability Zones visible to the account in the recorded permission region.',
    'Resolve any unavailable zone or an unsupported zone count outside Qiln, then create a new deployment.',
  ),
  AWS_DEPLOYMENT_INGRESS_INVALID: entry(
    'Administrator network is invalid',
    'The administrator CIDR must be a canonical IPv4 network with no host bits and a prefix from /1 to /32. The whole internet (/0) is refused. It controls only SSH access to the host security group.',
    'Enter the administrator network in canonical form, such as 203.0.113.7/32.',
  ),
  AWS_DEPLOYMENT_RECORDED: entry(
    'Deployment evidence blocks local disconnect',
    'Retained deployment evidence indicates that AWS resources may remain, that an operation outcome is unresolved, or that child termination was not confirmed. Local removal would discard the managed binding needed to reason about them. Qiln does not delete AWS resources, adopt candidates, or clear uncertainty automatically.',
    'Inspect the displayed deployment evidence with qiln aws deployment status, and the actual AWS resources it names.',
    'Preserve the retained deployment record and the connection record. They are the only local evidence binding these resources to this operator, even if the operator user or its credentials are later deleted or lost; deleting local state is never recovery.',
    'Resolve outstanding resources through an explicitly reviewed administrator procedure using the recorded account, region, and deployment tag.',
    'Retry disconnect only after retained evidence establishes that no resource effects remain.',
  ),
  AWS_DEPLOYMENT_NOT_ATTEMPTED: entry(
    'AWS deployment mutation was not attempted',
    'The isolated credential process stopped before sending any mutating call: the retained deployment evidence, approval, bindings, or authenticated identity did not match, or a credential or read step failed before the mutation was dispatched. Read-only calls may have been made. This describes only that attempt and does not clear earlier effects.',
    'Inspect the retained deployment evidence and the authenticated operator before repeating the command.',
    'Do not edit or delete protected deployment state to bypass the refusal.',
  ),
  AWS_DEPLOYMENT_REFUSED: entry(
    'AWS refused to create a network resource',
    'AWS definitively refused a creation call, reporting an invalid or conflicting address range. Qiln validates the pinned VPC range and derives every subnet range from it before approval, so this indicates a defect in the pinned defaults or an account-level restriction, not an operator-correctable input. That call created nothing, and the refused attempt is never retried.',
    'Report the recorded deployment ID and its approved CIDR to the maintainers; the ranges cannot be changed from the command line.',
    'Review any account-level restriction on the ranges through an explicitly approved procedure.',
    'Clean up any resources already created with qiln aws deployment remove. A later release with corrected defaults needs a new deployment and a new approval.',
  ),
  AWS_DEPLOYMENT_LIMIT: entry(
    'AWS resource limit prevents creation',
    'AWS definitively refused a creation call because a regional limit was reached for VPCs, subnets, internet gateways, route tables, security groups, or security group rules. That call created nothing. Qiln does not probe, raise, or manage quotas.',
    'Review existing resources in the account and region through an explicitly approved procedure, or request a quota change outside Qiln.',
    'Clean up any resources already created with qiln aws deployment remove, then create a new deployment; the refused attempt is never retried.',
  ),
  AWS_DEPLOYMENT_BLOCKED: entry(
    'Network removal is blocked by dependencies',
    'AWS refused a deletion or detachment because dependent resources remain. That call removed nothing. Qiln never removes dependents it did not record and does not inventory them.',
    'Inspect and resolve the dependent resources through an explicitly reviewed procedure.',
    'Then inspect the deployment again; a later removal needs a fresh observation and a new approval.',
  ),
  AWS_DEPLOYMENT_VERIFICATION_FAILED: entry(
    'Network outcome was not verified',
    'A bounded observation ended without the expected result or returned an incompatible response. A recorded mutation may already have completed, and Qiln did not repeat it. An exhausted budget does not prove that the mutation failed, that a resource is absent, or who changed it.',
    'Inspect the retained deployment evidence, then inspect the recorded deployment again when ready.',
    'Compare actual AWS resources with the recorded account, region, and deployment tag before any manual recovery.',
  ),
  AWS_DEPLOYMENT_EVIDENCE_UNAVAILABLE: entry(
    'Step response evidence was not retained',
    'The provider call may have completed, but its returned identity could not be validated or retained locally. Creation calls carry no idempotency token, and Qiln never repeats an uncertain mutation, adopts candidate resources, or treats an empty listing as proof.',
    'Inspect the deployment evidence and the actual AWS resources tagged with the recorded operator and deployment.',
    'Resolve any resource through an explicitly reviewed procedure; a new create is a new deployment, never a retry.',
  ),
  AWS_DEPLOYMENT_RECOVERY_REQUIRED: entry(
    'AWS deployment recovery remains outstanding',
    'The original operation failed, or an earlier one left child termination unconfirmed, or the failure could not be written to the deployment evidence. A provider call may already have completed. No replay, adoption, deletion, rollback, or automatic recovery is attempted. While termination is unconfirmed, no further provider call runs and commands that authenticate are refused.',
    'Use the displayed termination and persistence outcomes to identify outstanding work.',
    'Retain potentially active authentication inputs and the protective operation lock until child activity has been checked.',
    'Compare actual AWS resources with the recorded account, region, and deployment tag.',
    'Do not edit or delete deployment evidence or lock files to bypass this state.',
  ),
  AWS_DEPLOYMENT_REMOVAL_REFUSED: entry(
    'Network removal was refused locally',
    'Removal requires confirmed prior termination, retained resource identities, refusal budget remaining (at most three definitely refused removal steps), no earlier step that is unresolved or uncertain, and a fresh observation matching the recorded network. Qiln cannot remove resources it cannot match to the record, including after partial external deletion. No deletion call was made.',
    'Inspect the displayed deployment evidence and the actual resources.',
    'Inspect the deployment again to retain a fresh observation before offering removal.',
    'Resolve unexpected changes to the network through an explicitly reviewed procedure outside Qiln.',
  ),
})
