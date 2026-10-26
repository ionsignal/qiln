import type { HelpContent } from '../../terminal/help'

export const group: HelpContent = {
  examples: [
    'qiln installation list',
    'qiln installation status --local',
    'qiln installation inspect --alias <alias>',
    'qiln installation configure --local --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    'qiln installation configure --id <deployment-id> --source <checkout-on-target> --image <alias-or-fingerprint>',
  ],
  safety: [
    'status, inspect and configure need exactly one target: --local for this machine, or --alias or --id for a retained AWS deployment. There is no default, so a command never silently chooses between this machine and a remote host.',
    'An AWS target is resolved from the retained deployment record alone. Installation never authenticates to AWS and never fills a gap: it needs a retained host-key pin, a ZFS pool verified imported with its scrub timer, an Incus initialization verified and not released, and no unresolved preparation step. Run qiln aws deployment verify and prepare first. Everything about the target is observed over the pinned, key-authenticated SSH connection, and Incus is reached through a new connection that relays its Unix socket. Recorded preparation state is point-in-time evidence, not proof that Incus is running.',
    'The operator machine needs only ssh-keygen for an AWS target. A local target requires the supported Ubuntu host, the preinstalled tools, local Incus access, and ZFS storage.',
    'Installation uses the invoking operator’s existing authority only. Incus administrative access is root-equivalent development authority, and the development orchestrator is not a production privilege boundary.',
    'Installation state and credentials live in one protected named installation directory under the Qiln state directory: dev for this machine, and aws-<deployment-id> for a deployment. A record is bound to its host, architecture, layout, and checkout path, and a different one is refused, not rebound.',
  ],
}

export const list: HelpContent = {
  examples: ['qiln installation list'],
  safety: [
    'Reads local installation records only. It contacts no target, uses no credentials, and takes no lock.',
    'A record that cannot be read fails the whole listing instead of being skipped.',
  ],
}

export const status: HelpContent = {
  examples: ['qiln installation status --local', 'qiln installation status --alias <alias>', 'qiln installation status --id <deployment-id>'],
  safety: [
    'Reports the retained binding, image pin and configuration evidence without contacting the target, authenticating to AWS, or taking a lock, so it also works while another operation holds one.',
    'Retained evidence does not establish the live state of the target. Use inspect for a fresh observation.',
    'An unresolved configuration step is reported as blocking evidence. Nothing is replayed, resumed, or cleared.',
  ],
}

export const inspect: HelpContent = {
  examples: ['qiln installation inspect --local', 'qiln installation inspect --alias <alias>', 'qiln installation inspect --id <deployment-id>'],
  safety: [
    'Read-only inspection: Qiln does not change host, installer, or Incus state, and registers nothing. It needs no image selection and works for a target with no registered installation, which it reports.',
    'It checks the target, the recorded installation state, the Incus daemon, and the storage and network of the layout. When an installation is registered, it also checks the retained binding and checkout, and, when an image is pinned and the orchestrator exists, the instance against the pinned image.',
    'The checkout check runs no Git status and no repository hook: it reads only the Git root, the committed baseline, and the package name.',
    'Reading the Incus API of an active socket can start the daemon through socket activation, and Qiln never starts units itself.',
  ],
}

export const configure: HelpContent = {
  examples: [
    'qiln installation configure --local --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    'qiln installation configure --local --source <checkout> --image <alias-or-fingerprint>',
    'qiln installation configure --alias <alias> --source <checkout-on-target> --image-meta <metadata> --image-rootfs <rootfs>',
  ],
  safety: [
    'Qiln observes the target first, then displays one installation plan and applies it only after an explicit default-no approval. Each Incus change is journaled with its approval in the installation directory, and a failed or interrupted change is never replayed, resumed, or rolled back. An installation that already matches needs no approval and no terminal. The first run registers the installation, and a later run must match its binding.',
    '--source names the checkout root on the target machine. For an AWS target it must be an absolute path there and is validated through the pinned SSH connection. Qiln does not create, update or synchronize it, and intentional working-tree changes are accepted.',
    '--image verifies an existing local alias or full lowercase SHA-256 fingerprint on the target. It does not pull or replace an image.',
    '--image-meta with --image-rootfs stages and fingerprints the artifacts on this machine first and uploads them. Content identical to the managed qiln-orchestrator-dev alias target is never replaced. New content is imported without an alias and checked as a container image for the target architecture before anything else changes. If that fails, the imported image remains in the image store without an alias, the previous image is untouched, and you must remove the imported image manually. If the alias targets different content, deleting that image, with the aliases attached to it, is displayed in the plan and happens only after approval and only after the new image passes its check. It is refused while an orchestrator instance exists, so remove the stopped instance manually first. No automatic rollback is attempted.',
    'The first credential set requires --authorized-keys. Later runs reuse retained credentials; a supplied roster replaces only authorized_keys. Credentials are generated and kept on this machine, and only the four intended credentials are delivered to the validated stopped instance.',
    'The selected image is trusted guest code. Qiln does not establish its provenance, authenticity, guest compatibility, or bootstrap readiness.',
    'The target checkout is attached as a writable shifted source device, so the instance can modify it. No source copying or service startup is performed. The configured orchestrator remains stopped.',
    'Run as an unprivileged developer. Persistent PostgreSQL data is preserved; incompatible retained resources require manual review. An AWS target also needs a target with at least the memory of the orchestrator limit.',
  ],
}
