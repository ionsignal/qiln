import { AWS_SPEC } from '../../../aws/spec'
import type { HelpContent } from '../../../terminal/help'

export const group: HelpContent = {
  examples: [
    'qiln aws deployment create',
    'qiln aws deployment list',
    'qiln aws deployment status --alias <alias>',
    'qiln aws deployment verify --alias <alias>',
    'qiln aws deployment prepare --alias <alias>',
    'qiln aws deployment handoff --alias <alias>',
    'qiln aws deployment abandon --alias <alias>',
    'qiln aws deployment remove --alias <alias>',
    'qiln aws deployment inspect --id <deployment-id>',
  ],
  safety: [
    'create reviews one proposed host from read-only discovery and, after one approval, provisions the network, administrative key pair, instance, data volume, and Elastic IP as fenced calls with bounded observations, then reads AWS health. Success means AWS provisioning and health only: quotas, capacity, pricing, guest state, and reachability are not checked.',
    `A deployment is selected by --alias or --id, never both, and with neither the default alias '${AWS_SPEC.deployment.defaultName}' is used. An alias is local metadata only, never an AWS tag, and deployment records are never deleted.`,
    'status, list, and handoff make no AWS call. inspect, abandon, and remove authenticate as the recorded operator, while verify and prepare connect over the pinned SSH host key with the administrative key; ssh is reserved and makes no connection or AWS call.',
    'AWS deletes the root volume and primary interface with the instance, and Qiln removes the Elastic IP, key pair, and network. The data volume is retained by design because Qiln holds no DeleteVolume or DetachVolume authority, so it keeps incurring charges until it is deleted outside Qiln.',
    'A replacement that reuses a retained data volume reserves it when its approval is saved: handoff records a missing reservation or completion from local evidence, and abandon releases a reservation whose attach never returned. Until a replacement holds the volume, neither its alias nor the volume is offered to a later deployment.',
    'Deployment commands hold the exclusive AWS-operation lock, which is retained when child termination is unconfirmed. Connect, status, and every deployment command that authenticates or connects are refused while any deployment records unconfirmed child termination.',
  ],
}

export const create: HelpContent = {
  examples: [
    'qiln aws deployment create',
    'qiln aws deployment create --name default',
    'qiln aws deployment create --alias staging',
  ],
  safety: [
    `Without --name, create uses '${AWS_SPEC.defaultName}', which must be a Qiln-created operator with a current permission verification (see qiln aws connect). That authority covers all commercial regions and can be exercised outside Qiln, because the deployment region is a Qiln execution gate and not an AWS boundary.`,
    `Without --alias, create uses '${AWS_SPEC.deployment.defaultName}'; a taken alias is refused before any proposal and again when the approval is saved, which reserves it. It can be taken over only after the newest deployment using it was removed with nothing unresolved, abandoned its reservation, or never provisioned anything.`,
    'ssh-keygen must be on PATH and the administrator IPv4 network must be canonical and not /0, both checked before any AWS call. Discovery is read-only and inspects only the AMI that this release pins for the deployment region, never searching, refreshing, or substituting.',
    `The launch candidates are the available standard zones that offer ${AWS_SPEC.compute.defaultInstanceType}, each tried once in zone ID order and frozen in the approval, and Qiln moves on only after a definite, recorded capacity refusal. A reused data volume fixes its zone, and no instance type, image, region, or storage is ever substituted.`,
    'Declining the default-no approval saves nothing; approving saves the frozen plan, reserves the alias, generates one local owner-only Ed25519 administrative key, and creates billable resources immediately. Creation is fresh-only, and cancelling or failing never rolls back, retries, or regenerates anything.',
    'After AWS definitively refuses a creation, create offers to remove what was already created and, for a reused data volume, to release its reservation, each under its own default-no approval. The original refusal is still reported, and declining leaves the alias reserved.',
    'Reusing a retained data volume needs verified Incus release and ZFS export evidence and a fresh AWS observation, and only the Incus state and storage on it are preserved, not the root volume, rootfs edits, or external bind contents such as the development checkout. The image architecture must match a preserved Incus installation, and the volume keeps incurring charges until it is deleted outside Qiln.',
  ],
}

export const status: HelpContent = {
  examples: ['qiln aws deployment status --alias <alias>', 'qiln aws deployment status --id <deployment-id>'],
  safety: [
    'Reads local deployment evidence only: no credentials, no AWS call, and no lock, so it also works while another AWS operation holds the lock.',
    'The reported outcome is derived from retained facts and does not establish the current state of AWS resources; use inspect for a fresh observation.',
    'The administrative key is reported by fingerprint binding only, and local key files are not inspected. A deployment that reuses or reserved a retained data volume also reports the stage of that hand-off and the command that moves it forward.',
  ],
}

export const list: HelpContent = {
  examples: ['qiln aws deployment list'],
  safety: [
    'Reads local deployment evidence only: no credentials, no AWS call, and no lock, so it also works while another AWS operation holds the lock.',
    'Recorded states and verification labels do not establish the current state of AWS resources. An unreadable or incompatible record fails the whole listing instead of being skipped.',
  ],
}

export const inspect: HelpContent = {
  examples: ['qiln aws deployment inspect --alias <alias>', 'qiln aws deployment inspect --id <deployment-id>'],
  safety: [
    'Authenticates as the recorded operator and makes read-only EC2 calls, which may refresh temporary credentials. It never makes a mutating call and is refused while an earlier child process remains unconfirmed.',
    'Every recorded resource is observed in separate calls, not one atomic snapshot. When a creation outcome is unresolved, tagged candidate resources are also listed, displayed only and never adopted, and an empty listing proves nothing.',
    'An agreeing observation also verifies a step whose response was retained and records the root volume and interface that AWS created. When creation is complete and no health is retained, one non-polling AWS health read follows, and only a passing read is retained.',
    'Passing AWS health is point-in-time evidence and establishes no SSH access, guest state, or readiness.',
  ],
}

export const verify: HelpContent = {
  examples: ['qiln aws deployment verify --alias <alias>', 'qiln aws deployment verify --id <deployment-id>'],
  safety: [
    'Requires a fully created deployment with the administrative key bound, otherwise it is refused locally. Without a retained host-key pin it authenticates, requires one agreeing observation, and retains the AWS-reported console fingerprint, which is not guest attestation, before connecting; with a pin it makes no AWS call.',
    'The connection goes only to the retained address and only if the server presents the pinned Ed25519 host key, using public-key authentication with the administrative key. That key must be owner-only and derive the recorded fingerprint, and it is never generated, replaced, or repaired.',
    'Five fixed read-only probes run in order with bounded output and no retries: cloud-init (waits up to 600 seconds), the guest os-release (Ubuntu 26.04), the architecture, the administrative account, and passwordless sudo. The architecture is only observed and never compared, and sudo shows only that one invocation returned uid 0.',
    'A lost connection marks the remaining probes not run and the interrupted probe unverified, nothing is replayed, and cancelling prints no partial report. Run verify again if cloud-init does not finish within its wait.',
    'Nothing is installed, written, or retained on the guest, so passing does not establish host preparation, storage eligibility, effective sshd settings, or readiness. SSH is reachable only from the approved administrator network, which Qiln never changes.',
  ],
}

export const prepare: HelpContent = {
  examples: [
    'qiln aws deployment prepare',
    'qiln aws deployment prepare --alias <alias>',
    'qiln aws deployment prepare --id <deployment-id>',
  ],
  safety: [
    'Requires a fully created deployment, uses the retained host-key pin with no AWS call when one exists, and needs the guest baseline to pass before anything runs. Each displayed plan is applied only after its own default-no approval, and its screen lists the steps it covers.',
    'The phases are Incus close and repository, ZFS prerequisites, Incus packages, ZFS storage, and Incus activation, which keeps package effects away from an open daemon and from mounted Incus state. A pending reboot stops the command.',
    'The data volume is matched only by its recorded EBS volume ID. Qiln never wipes, repairs, adopts, forces, or renames existing storage or configuration, never edits /etc/subuid or /etc/subgid, and never reboots the host or installs a kernel or module.',
    'Each approved step is one fenced remote script followed by a fresh inspection that must agree, and a failed, cancelled, or unverified step is never replayed, resumed, or rolled back. An unresolved step blocks preparation and, depending on the step, removal, disconnect, or volume handoff.',
    'A preserved Incus installation is reopened only through the retained-volume chain against its recorded software, ID ranges, and server identity, and is never initialized over; qiln installation reassign records it as the host of an existing installation. Success does not establish workload correctness, restoration, runtime readiness, or SSH forwarding to the Incus socket.',
  ],
}

export const ssh: HelpContent = {
  examples: ['qiln aws deployment ssh --alias <alias>', 'qiln aws deployment ssh --id <deployment-id>'],
  safety: [
    'Interactive administrative SSH is not available yet: the command and its selectors are recognized, but it opens no protected state, takes no lock, reads no key, and makes no AWS call or SSH connection.',
    'It runs no login check, terminal, or remote command; use verify for the read-only guest baseline.',
  ],
}

export const handoff: HelpContent = {
  examples: ['qiln aws deployment handoff --alias <alias>', 'qiln aws deployment handoff --id <deployment-id>'],
  safety: [
    'Writes only local evidence derived from matching retained records: the missing reservation on the previous deployment, and the completed hand-off once verified attach or abandonment shows that the replacement holds the volume. It makes no AWS call and attaches, detaches, replays, or deletes nothing.',
    'It is refused when the previous deployment reserved the volume for a different deployment. A write is displayed first and needs a default-no approval, and when there is nothing to settle it reports so without a prompt.',
    'The volume stays retained and billable until it is deleted outside Qiln. The command holds the AWS-operation lock and is refused while any deployment records unconfirmed child termination.',
  ],
}

export const abandon: HelpContent = {
  examples: ['qiln aws deployment abandon --alias <alias>', 'qiln aws deployment abandon --id <deployment-id>'],
  safety: [
    'Releases a replacement’s reservation of a retained data volume whose attach never returned, for example after a cancelled creation. It authenticates as the recorded operator and makes one read-only observation that must agree with the record and show the volume available and unattached.',
    'It is refused unless child termination is confirmed, no step is unresolved or uncertain, and no resource the replacement created remains. A verified attach is completed with handoff, and an open or uncertain attach is never released automatically.',
    'After a default-no approval one local write releases the reservation: the replacement keeps answering for the volume, which stays retained and billable until it is deleted outside Qiln, and no further provider step may follow. Abandonment is not undone.',
    'Running it again after success reports that there is nothing to do. The command holds the AWS-operation lock and is refused while any deployment records unconfirmed child termination.',
  ],
}

export const remove: HelpContent = {
  examples: ['qiln aws deployment remove --alias <alias>', 'qiln aws deployment remove --id <deployment-id>'],
  safety: [
    'Selecting a deployment grants nothing: removal needs retained resource identities, confirmed prior child termination, an unspent refusal budget (three definite AWS refusals), no unresolved or uncertain step, and a fresh observation that matches the record. A deletion whose response was retained but never verified is verified by that observation and never repeated.',
    'When Qiln opened Incus and no AWS removal step has started, remove first connects over the pinned SSH connection and freshly checks Incus, even when an earlier release is retained. Active units are released under one default-no approval (instances stopped gracefully, never forced, then every unit masked and stopped), while inactive units without a verified release refuse removal until prepare reopens Incus.',
    'When an installation is assigned to this deployment and its managed checkout is present, its HEAD must be fetchable from the approved repository or removal is refused with no override in Qiln, which never pushes. After a separate default-no approval, and only once the workloads are stopped, that HEAD is recorded as the installation’s restore point, and other branches, uncommitted changes, and ignored files are lost with the root volume.',
    'A recorded ZFS pool that is still imported is unmounted, when its state dataset is mounted, and exported without force only after a separate default-no approval, while a pool observed absent is accepted only with retained evidence of its verified export. An unresolved ZFS step, or an unresolved Incus step once Incus was opened, refuses removal before any connection or AWS call.',
    'An unreachable host or a failed, refused, or unverified check refuses removal with no override in Qiln, so such a deployment must be cleaned up manually outside Qiln. Once AWS removal has started, SSH is no longer used and retained release and export evidence is point-in-time.',
    'After a separate default-no approval, removal runs serially in dependency order (Elastic IP, instance, key pair, network), one call and one observation each, and stops at the first refused or uncertain step without rollback. AWS deletes the root volume and primary interface with the instance, the data volume is retained, never reported as removed, and keeps incurring charges until it is deleted outside Qiln, and deleting the AWS key pair is neither guest SSH revocation nor deletion of the local key files.',
  ],
}
