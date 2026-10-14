import { AWS_SPEC } from '../../../aws/spec'
import type { HelpContent } from '../../../terminal/help'

export const group: HelpContent = {
  examples: [
    'qiln aws deployment create',
    'qiln aws deployment list',
    'qiln aws deployment status --alias <alias>',
    'qiln aws deployment remove --alias <alias>',
    'qiln aws deployment inspect --id <deployment-id>',
  ],
  safety: [
    'create is a read-only preview of one proposed GPU host. It discovers the reviewed image, instance type, and placement, displays the proposal, and always ends with an execution-unavailable diagnostic: no approval is saved, no alias is reserved, no SSH key is generated, and no AWS resource is created. Quotas, capacity, pricing, guest operation, and reachability are not checked.',
    'list, status, inspect, and remove operate on retained deployment records and account for every resource a record names. The network is a VPC, one /24 subnet per standard Availability Zone, an internet gateway, a route table that sends 0.0.0.0/0 to the gateway, and one host security group. A host record adds one instance with its root volume and primary network interface, one separately created data volume, an Elastic IP and its association, and the AWS key pair. No command in this release creates these resources, and the operator’s compute permissions are not used by the preview.',
    'Resources have different lifecycles. AWS deletes the root volume and primary interface with the instance. Qiln deletes the Elastic IP association and allocation, the AWS key pair, and the network. The data volume is retained by design: Qiln holds no DeleteVolume or DetachVolume authority, so it remains, is reported as retained rather than removed or absent, and keeps incurring charges until it is deleted outside Qiln.',
    'Remove requires its own interactive yes/no approval that defaults to no. Later commands resolve the connection and every binding from the deployment record; there are no resource-ID, region, tag, CIDR, or rebinding options.',
    `Each retained deployment has a unique local alias (default: ${AWS_SPEC.deployment.defaultName}), displayed as qiln-<alias> beside its immutable ID. status, inspect, and remove select by --alias or --id, never both; with neither they select the default alias. An alias is local metadata only: it is not an AWS tag and never changes a resource name. Deployment records are never deleted, so an alias is not reused after removal. Selecting a deployment never bypasses the fresh observation and approval that removal requires.`,
    'Provider work runs as one fenced call per step, each followed by a bounded observation of the recorded resources. Deployment commands hold the exclusive AWS-operation lock, which is retained when child termination is unconfirmed. Connect, status, and the deployment commands that authenticate are refused while any deployment records unconfirmed child termination. Recovery is forward-only: Qiln does not replay uncertain mutations, adopt resources, or resume abandoned work.',
    'A mutating call that failed before it was sent is recorded as not attempted. A failure during or after sending, and any transport failure, stays uncertain.',
    'Deployment records are retained across disconnect, which refuses while effects remain outstanding and discloses retained storage. Qiln never deletes AWS resources or deployment evidence automatically. Completion does not establish public reachability, working HTTPS or SSH, launch authority, capacity, Ubuntu compatibility, readiness, or rollback.',
  ],
}

export const create: HelpContent = {
  examples: [
    'qiln aws deployment create',
    'qiln aws deployment create --name default',
    'qiln aws deployment create --alias staging',
  ],
  safety: [
    `Without --name, create uses '${AWS_SPEC.defaultName}'. The connection must be a Qiln-created operator whose recorded permission verification matches the current requirement; otherwise run qiln aws connect to review and approve a policy update. That update grants EC2 launch, termination, volume, Elastic IP, and key-pair authority that can be exercised outside Qiln; a deployment record is a Qiln execution gate, not an AWS authorization boundary. Arbitrary existing IAM users remain authentication-only.`,
    `Without --alias, create uses '${AWS_SPEC.deployment.defaultName}'. The alias is checked against retained deployment records so a taken one is refused early, but the preview neither reserves nor consumes it. It is local metadata only.`,
    'The only prompted input is the administrator IPv4 network allowed to reach SSH. It must be canonical with no host bits and not /0, and is validated before any AWS call. Ports 80 and 443 are shown open to the internet.',
    `Discovery is read-only and uses the managed permission region, not the editable login default. It inspects the AMI that this Qiln release pins for that region by image ID and numeric publisher account, and expects the reviewed release '${AWS_SPEC.compute.image.name}' from the '${AWS_SPEC.compute.image.owner}' owner. It never searches for an image, follows a moving latest alias, refreshes the index, or substitutes another image, release, distribution, architecture, or region. A region without a reviewed entry stops locally before any prompt, authentication, or AWS call. It also reads the ${AWS_SPEC.compute.instanceType} instance type, standard Availability Zones, and per-zone offerings. Authentication may refresh the local credential cache.`,
    `The host Availability Zone is the lowest zone ID that is available and offers ${AWS_SPEC.compute.instanceType}. An offering is not a capacity reservation, quotas are not queried, and the zone is never changed automatically.`,
    'Missing compatibility evidence never passes. The instance type must explicitly report ENA support, and an omitted image boot mode is judged by the documented x86 default, legacy BIOS, so the instance type must list it. uefi-preferred needs either mode, and an unrecognized boot mode blocks.',
    `The screen separates observed AWS metadata, documented release expectations, and intended future behavior. Findings are blockers or reviews. A blocker ends the command without a prompt, and the intended configuration is displayed only when no blocker exists. A root volume larger than the ${AWS_SPEC.compute.storage.rootSizeGiB} GiB the compute policy authorizes is a blocker, because that policy would refuse the launch. Reviews, such as a future deprecation date or product codes, are displayed but do not suppress the prompt.`,
    'The intended launch configuration is one frozen plan: the instance count, the image root snapshot and device name, root and data volume settings and retention, the primary network interface without an automatic public address, instance metadata settings, the administrative key algorithm and passphrase mode, and Elastic IP reassociation policy. Nothing in it is filled from provider defaults later, and it is not saved by this preview.',
    'The screen also states the intended removal contract: the instance is terminated, the root volume and primary interface are deleted with it, the Elastic IP is disassociated and released, the AWS key pair is deleted without revoking guest or local keys, the network is deleted, and the data volume is retained, never reported as absent, and billed until it is deleted outside Qiln. Approval is not automated spend protection and no cost estimate is shown.',
    'Image block-device mappings are classified. Additional EBS mappings, mappings that cannot be recognized, a root mapping without a snapshot, and a mapping that already uses the data volume device name block the preview, while instance-store mappings are reported as ephemeral and outside the durable storage plan.',
    'The prompt defaults to no and answering no is an ordinary cancellation. Answering yes stops with an execution-unavailable diagnostic before any approval is saved, alias reserved, SSH key generated, or AWS resource created.',
    'The proposal is held in memory only and is separate from retained deployment records. Quotas, capacity, pricing, guest operation, and reachability are not verified. Requires an interactive terminal and the saved operator login.',
  ],
}

export const status: HelpContent = {
  examples: ['qiln aws deployment status --alias <alias>', 'qiln aws deployment status --id <deployment-id>'],
  safety: [
    'Reads local deployment evidence only. No credentials are used and no AWS call is made, so it also works while another AWS operation holds the lock.',
    'The reported outcome is derived from retained facts. It does not establish the current state of AWS resources; use inspect for a fresh observation.',
  ],
}

export const list: HelpContent = {
  examples: ['qiln aws deployment list'],
  safety: [
    'Reads local deployment evidence only. No credentials are used, no AWS call is made, and no lock is required, so it also works while another AWS operation holds the lock.',
    'Recorded states and verification labels are derived from retained facts. They do not establish the current state of AWS resources; use inspect for a fresh observation.',
    'An unreadable or incompatible record fails the whole listing instead of being skipped.',
  ],
}

export const inspect: HelpContent = {
  examples: ['qiln aws deployment inspect --alias <alias>', 'qiln aws deployment inspect --id <deployment-id>'],
  safety: [
    'Authenticates as the recorded operator and makes read-only EC2 calls. Like aws status, it may refresh temporary credentials.',
    'With retained resource identities it observes every recorded resource, including the instance, its volumes, interface, Elastic IP, and key pair. The reads are several separate calls, not one atomic snapshot. Without any identity it lists VPCs, instances, volumes, addresses, and key pairs carrying the recorded operator and deployment tags for display only: candidates are never adopted, and an empty listing proves nothing.',
    'An observation that agrees with the retained evidence also verifies a step whose response was retained but not yet verified, and records the root volume and interface that AWS created with the instance. Inspecting never makes a mutating call.',
    'Absence never proves who deleted a resource. A running instance is not reported as healthy, and inspection establishes no SSH access or readiness. Inspection is refused while an earlier child process remains unconfirmed.',
  ],
}

export const remove: HelpContent = {
  examples: ['qiln aws deployment remove --alias <alias>', 'qiln aws deployment remove --id <deployment-id>'],
  safety: [
    'Selecting a deployment by alias or ID grants nothing: removal still needs retained resource identities, confirmed prior child termination, an unspent refusal budget (at most three definitely refused removal steps), and no earlier step that is unresolved or uncertain. Only a definite earlier refusal permits another attempt; verified deletions never spend the budget.',
    'A fresh observation must match the recorded resources; otherwise removal is refused and no deletion call is made, including after partial external deletion or when a retained volume differs from its approved attachment or retention setting. If every removable resource is observed absent, no call is made either.',
    'After a separate yes/no approval that defaults to no, the displayed effects run serially in dependency order: disassociate and release the Elastic IP, terminate the instance, delete the AWS key pair, then remove the network. Each is one call followed by an observation. The run stops at the first refused or uncertain step; completed deletions are preserved, and another invocation needs a fresh observation and approval.',
    'The root volume and primary interface are deleted by AWS with the instance, and are reported only once observed absent. The data volume is retained by design: Qiln has no DeleteVolume or DetachVolume authority, so it is reported as retained, identified, and observed unattached, never as removed or absent. It keeps incurring charges until it is deleted outside Qiln.',
    'This release creates, inspects, and deletes no local SSH key. Deleting the AWS key pair does not remove any key from the guest and is not SSH revocation. Disassociating an Elastic IP is not releasing it; each is verified separately.',
    'AWS refusal because dependent resources remain is the only dependency gate; Qiln never removes dependents it did not record. Absence is observed and retained after each deletion.',
    'Removal uses the permission evidence recorded with the deployment and never forces a root permission review. It is not rolled back once attempted, and it does not reverse any effect outside the recorded resources.',
  ],
}
