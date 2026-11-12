import type { HelpContent } from '../../terminal/help'

export const group: HelpContent = {
  examples: [
    'qiln installation list',
    'qiln installation status --local',
    'qiln installation inspect --alias <alias>',
    'qiln installation configure --local --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    'qiln installation configure --id <deployment-id> --image <alias-or-fingerprint>',
    'qiln installation reassign --id <deployment-id>',
  ],
  safety: [
    'status, inspect and configure need exactly one target: --local for this machine, or --alias or --id for a retained AWS deployment, with no default. reassign takes only --alias or --id.',
    'An AWS target is resolved from retained deployment evidence, so run qiln aws deployment verify and prepare first. Only configure uses the saved operator login, and only to acquire the installation’s domain and certificate; list, status, inspect and reassign never authenticate to AWS. Everything is observed over the pinned SSH connection with the Incus socket relayed through it, and recorded preparation state is point-in-time evidence, not proof that Incus is running.',
    'An AWS target owns its checkout at /home/<account>/qiln, cloned from github.com/ionsignal/qiln and restored at its recorded restore point whenever absent. Qiln never pulls, pushes, or judges the working tree, so work survives a host replacement only once pushed, and qiln aws deployment remove refuses an unpushed HEAD.',
    'Installation uses the invoking operator’s existing authority only. Incus administrative access is root-equivalent, and the development orchestrator is not a production privilege boundary.',
    'State and credentials live in one protected installation directory: dev for this machine, and aws-<deployment-id> for a deployment, where the ID is that of the deployment that created the retained volume and stays the same across replacement hosts. A record is bound to its host, architecture, layout, and checkout path, and a later deployment of the same volume is refused until reassign records it.',
  ],
}

export const list: HelpContent = {
  examples: ['qiln installation list'],
  safety: [
    'Reads local installation records only: it contacts no target, uses no credentials, and takes no lock.',
    'A record that cannot be read fails the whole listing instead of being skipped.',
  ],
}

export const status: HelpContent = {
  examples: ['qiln installation status --local', 'qiln installation status --alias <alias>', 'qiln installation status --id <deployment-id>'],
  safety: [
    'Reports the retained binding, previous hosts, checkout restore point, image pin, domain allocation and certificate window, and configuration and startup evidence without contacting the target, authenticating to AWS, or taking a lock, so it also works while another operation holds one.',
    'Retained evidence does not establish the live state of the target, so use inspect for a fresh observation. The restore point is the commit that configure restores when a managed checkout is absent, not a statement about the running tree.',
    'An unresolved configuration or startup step is reported as blocking evidence and is never cleared. A domain request whose outcome was never recorded is reported too, and it blocks nothing.',
  ],
}

export const inspect: HelpContent = {
  examples: ['qiln installation inspect --local', 'qiln installation inspect --alias <alias>', 'qiln installation inspect --id <deployment-id>'],
  safety: [
    'Read-only: Qiln changes no host, installer, or Incus state and registers nothing. It needs no image selection and works for a target with no registered installation, which it reports.',
    'It checks the target, the recorded installation state, the Incus daemon, and the layout’s storage and network, and for a registered installation also its binding, checkout, and instance against the pinned image.',
    'A local checkout is judged by its Git root, committed baseline, and package name. A managed checkout is reported as present or absent with its HEAD as information only, and no Git status, hook, or network call runs.',
    'Reading the Incus API of an active socket can start the daemon through socket activation, and Qiln never starts units itself.',
    'A deployment that holds the retained volume of an installation assigned to an earlier deployment is refused until reassign records it.',
  ],
}

export const configure: HelpContent = {
  examples: [
    'qiln installation configure --local --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    'qiln installation configure --local --source <checkout> --image <alias-or-fingerprint>',
    'qiln installation configure --alias <alias> --image-meta <metadata> --image-rootfs <rootfs>',
  ],
  safety: [
    'Qiln observes the target, displays one plan, and applies it only after a default-no approval, and an installation that already matches needs no approval. Each Incus change and the one checkout clone is journaled and verified by a fresh observation, and the plan must be unchanged when derived again after approval.',
    '--image verifies an existing local alias or full lowercase fingerprint and never pulls or replaces an image. --image-meta with --image-rootfs stages and uploads artifacts, never replaces identical content, and imports new content without an alias, checked as a container image for the target architecture first.',
    'Replacing a different managed image is approved in two gates: the import (with any checkout clone) first, then, once the imported image passes its check, deleting the previous image with its aliases. A rejected import leaves the previous image untouched and the imported one unaliased in the store, where Qiln never deletes it, and replacement is refused while an orchestrator instance exists.',
    '--source names the checkout root on this machine, is required with --local, and is refused for an AWS target. An AWS target’s managed checkout is cloned at its restore point (origin’s current main on the first run) in one fenced step that never overwrites a path, and git must already exist on the target.',
    'An AWS target also obtains its stable public name and wildcard certificate from the Qiln registration service before any Incus change, under one default-no approval of its own. The plan is derived once first, so a refusal that local and Incus state already determine is reported before the service is contacted. This is the only step that uses the saved operator login: an isolated credential process checks it against the deployment’s recorded operator and sends the service a signed identity proof that includes the session token, and Qiln never starts a sign-in. The TLS key stays on this machine until the plan below delivers it. An interrupted or uncertain attempt is recorded, shown by status, and never blocks or replays itself, and DNS records and certificates are not rolled back if a later step fails. Public reachability is not part of this step, and a local target does not use the service. Delivery to the stopped instance is part of the installation plan that follows, under its own approval.',
    'The first credential set requires --authorized-keys, and later runs reuse the retained set, with a supplied roster replacing only authorized_keys. Credentials are generated and kept on this machine, and the four intended credentials are delivered to the stopped instance together with the generated ingress configuration: the public origin, the advertised SSH endpoint, and the Caddy configuration, plus the retained TLS certificate and key for an AWS target, while a local target receives a plain-HTTP configuration for the orchestrator’s own address. A renewed certificate or changed endpoint is delivered without regenerating the credentials. Delivery shows only that the stopped instance holds that configuration, not that services started, DNS is correct, the certificate is publicly trusted, or any port is reachable.',
    'An AWS target also publishes TCP ports 80, 443 and 2222 on the host’s private address through NAT proxy devices, so the orchestrator sees client addresses. They are created with the instance and reconciled by the same guarded update, including on a replacement host. Qiln opens no cloud firewall port, so reachability from outside is not established.',
    'The selected image and the cloned checkout are trusted guest code, and the checkout is attached to the instance as a writable shifted source device. Configuration leaves the orchestrator stopped, and persistent PostgreSQL data is preserved.',
    'Once the stopped installation is verified and a terminal is available, a separate default-no approval covers startup: Qiln starts the orchestrator, then runs npm install, the development build, the database migrations and grants, and the first-administrator creation as transient systemd units named qiln-startup, each journaled and verified, and starts the SSH and Web services without enabling them. Every command runs through root exec over the Incus socket, which is already root-equivalent authority, and its output stays in the guest journal (journalctl -u qiln-startup).',
    'Startup writes node_modules and build outputs into the writable checkout, which is your own working copy for a local target, and changes the persistent PostgreSQL volume without rollback. The first administrator is prompted locally with a hidden password, pushed as a one-shot protected file, and removed when the script reads it. A failed or interrupted step is never replayed and blocks later startups until startup.json in the installation directory is removed by hand. Declining leaves the installation configured and stopped, and a running installation is only checked for readiness.',
    'A unit that exits zero and a health answer inside the guest show completion only, not application correctness. A browser is opened only after the origin’s /health also answers from this machine, and a failed probe or browser only warns, because DNS, certificate trust, and routing from here do not show that the services are down.',
  ],
}

export const reassign: HelpContent = {
  examples: ['qiln installation reassign --alias <alias>', 'qiln installation reassign --id <deployment-id>'],
  safety: [
    'Moves an existing installation to a replacement deployment that holds its retained data volume, keeping its directory, credentials, image pin, checkout binding, and history. Only the current host assignment changes, and local installations are never reassigned.',
    'It needs a configured, settled installation and every earlier deployment of the volume chain released, exported, removed, and handed on, and the selected deployment must hold the same Incus server identity, retained preseed, and ZFS pool. These are retained evidence, not fresh proof, and nothing is inferred from an alias, hostname, tag, or instance name.',
    'The live installation must already match, and planning is only a predicate: reassign never creates, repairs, or completes anything. The managed checkout may be absent on the replacement, and published port devices may still name the earlier host address, so the next configure restores the checkout from the recorded restore point and reconciles the ports.',
    'After a default-no approval the same checks run again under the AWS-operation and installation locks, then one atomic write records the new host and keeps the old one in the history. No Incus resource, credential, or image changes, and no workload starts.',
    'An uncertain write stops the command, and a later command reads the record as authoritative. Reassignment is planned host replacement, not clustering, failover, upgrade, or disaster recovery, and retention is not a backup.',
  ],
}
