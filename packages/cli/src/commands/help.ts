import type { HelpContent } from '../terminal/help'

export function root(awsAvailable: boolean): HelpContent {
  return {
    examples: ['qiln doctor --help', 'qiln up --help', ...(awsAvailable ? ['qiln aws --help'] : [])],
    safety: [
      'Operational commands use only the unprivileged developer’s existing authority on the machine where Qiln runs. Qiln never invokes sudo or another privilege-escalation mechanism locally. Approved AWS host preparation is the one exception in kind: after separate approval of each plan, it runs reviewed scripts with sudo on the deployment host over the pinned SSH connection.',
      'Review command-specific help for side effects and recovery boundaries.',
    ],
  }
}

export const doctor: HelpContent = {
  examples: ['qiln doctor', 'qiln doctor --color never'],
  safety: [
    'Read-only inspection: Qiln does not change host, installer, or Incus state.',
    'Requires the supported Ubuntu host, preinstalled tools, local Incus access, and ZFS storage. Required host administration is performed manually.',
  ],
}

export const up: HelpContent = {
  examples: [
    'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
    'qiln up --source <checkout> --image <alias-or-fingerprint>',
    'qiln up --source <checkout> --image-meta <metadata> --image-rootfs <rootfs> [--authorized-keys <roster>]',
  ],
  safety: [
    '--image verifies an existing local alias or full lowercase SHA-256 fingerprint. It does not pull or replace an image.',
    '--image-meta with --image-rootfs explicitly authorizes deleting the image targeted by the managed qiln-orchestrator-dev alias before importing or reusing staged content. Other aliases on that image may be removed. No automatic rollback is attempted.',
    'The first credential set requires --authorized-keys. Later runs reuse retained credentials; a supplied roster replaces only authorized_keys.',
    'Installation state and credentials live in one protected named installation directory (dev for this workflow) under the Qiln state directory. Its record is bound to this machine, architecture, layout, and source checkout, and a different checkout or layout for the same installation is refused, not rebound. State that earlier versions kept directly in the state directory is refused and never read, migrated, or deleted.',
    'The selected image is trusted guest code. Qiln does not establish its provenance, authenticity, guest compatibility, or bootstrap readiness.',
    'The canonical host checkout is attached as a writable shifted source device. No source copying or service startup is performed. The configured orchestrator remains stopped.',
    'Run as an unprivileged developer. Persistent PostgreSQL data is preserved; incompatible retained resources require manual review.',
  ],
}
