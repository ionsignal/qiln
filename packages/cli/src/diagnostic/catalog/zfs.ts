import { entry } from './define'

export const zfsDiagnostics = Object.freeze({
  ZFS_INSPECTION_FAILED: entry(
    'ZFS inspection did not complete reliably',
    'Qiln validates every section of one fixed read-only inspection before planning or verifying a step, so missing or malformed output stops the command. The displayed reason names what was missing; the inspection changes nothing, and steps completed earlier in the run are retained, not undone.',
    'Review the displayed reason, then confirm the guest baseline with qiln aws deployment verify.',
    'Run prepare again; Qiln does not retry or accept partial inspection output.',
  ),
  ZFS_PLAN_REFUSED: entry(
    'ZFS preparation is not supported for this host state',
    'Qiln plans ZFS preparation only for a package-owned ZFS module built for the running kernel and a recorded data volume that is blank or holds its recorded pool with exactly its recorded datasets. It never installs kernels or modules, or wipes, repairs, adopts, forces, or works around existing storage, and no further step was started.',
    'Review each displayed reason and resolve the condition outside Qiln, then run prepare again.',
    'Do not wipe or repartition the data volume to force a plan; an unexpected signature may be data that should be kept.',
  ),
  ZFS_REBOOT_REQUIRED: entry(
    'The host asks for a reboot before ZFS preparation',
    'A pending reboot means the running kernel and installed packages may not match what a later step would observe. Qiln never reboots the host, and no further step was started.',
    'Reboot the host through an approved procedure outside Qiln.',
    'Run prepare again; it inspects the host from scratch.',
  ),
  ZFS_STATE_INVALID: entry(
    'ZFS preparation evidence is unsafe or incompatible',
    'The deployment’s zfs.json must keep its supported schema, ownership, permissions, and binding to the deployment record. An unreadable, inconsistent, or earlier-layout record does not show that no host effects occurred, and it is never repaired, migrated, or discarded.',
    'Inspect the protected deployment directory and zfs.json; do not edit or delete evidence while another Qiln process may be active.',
    'Compare the actual host with the recorded deployment before any manual recovery.',
  ),
  ZFS_PREPARATION_UNRESOLVED: entry(
    'ZFS preparation has an unresolved step',
    'A fenced step has no verified outcome: it was interrupted, exited nonzero, or was not verified by a fresh inspection. Qiln never replays or resumes it. An unresolved pool step blocks prepare, removal, disconnect, and volume handoff; any other blocks prepare and removal that must release the host over SSH.',
    'Review the displayed unresolved steps and resolve the host state outside Qiln; no command clears unresolved evidence.',
    'Do not edit or delete preparation evidence to bypass this state.',
  ),
  ZFS_STEP_FAILED: entry(
    'A ZFS preparation step did not complete reliably',
    'Each approved step is one fenced remote script, and the displayed outcome is authoritative: a refused step had no effect, while an uncertain step may have run partly or fully. Qiln never replays, resumes, or rolls back a step, and package installation can load ZFS and start ZFS services on its own.',
    'After a refusal, correct the cause outside Qiln and run prepare again.',
    'After an uncertain outcome, inspect the host outside Qiln first; the step stays unresolved, and prepare and remove refuse to continue until it is resolved through a reviewed procedure.',
  ),
  ZFS_EXPORT_REQUIRED: entry(
    'The recorded ZFS pool must be cleanly exported first',
    'The deployment records a pool that is still imported, or the check could not run. Qiln never removes a host or hands off its volume without a clean export, because that could force a later import; remove exports the pool under its own approval before any AWS removal step. This command changed nothing.',
    'Run qiln aws deployment remove, which releases Incus when needed and then unmounts and exports the pool. If the pool is recorded as imported but absent from the host, run prepare first.',
    'If the host cannot be reached, clean it up manually outside Qiln; Qiln never forces an export.',
  ),
})
