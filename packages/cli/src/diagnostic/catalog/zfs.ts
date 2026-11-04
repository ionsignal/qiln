import { entry } from './define'

export const zfsDiagnostics = Object.freeze({
  ZFS_INSPECTION_FAILED: entry(
    'ZFS inspection did not complete reliably',
    'The fixed read-only inspection returned missing or malformed output, so the command stopped without changing anything or undoing earlier steps.',
    'Review the displayed reason, then confirm the guest baseline with qiln aws deployment verify.',
    'Run prepare again; Qiln does not retry or accept partial inspection output.',
  ),
  ZFS_PLAN_REFUSED: entry(
    'ZFS preparation is not supported for this host state',
    'Qiln plans ZFS preparation only for a package-owned module built for the running kernel and a data volume that is blank or holds its recorded pool with exactly its recorded datasets, or with only its root dataset when its datasets were never verified, and it never installs kernels or modules or wipes, repairs, adopts, or forces storage.',
    'Review each displayed reason and resolve the condition outside Qiln, then run prepare again.',
    'Do not wipe or repartition the data volume to force a plan; an unexpected signature may be data that should be kept.',
  ),
  ZFS_REBOOT_REQUIRED: entry(
    'The host asks for a reboot before ZFS preparation',
    'A pending reboot means the running kernel and installed packages may not match what a later step would observe, and Qiln never reboots the host.',
    'Reboot the host through an approved procedure outside Qiln.',
    'Run prepare again; it inspects the host from scratch.',
  ),
  ZFS_STATE_INVALID: entry(
    'ZFS preparation evidence is unsafe or incompatible',
    'The deployment’s zfs.json must keep its supported schema, ownership, permissions, and binding, and an unreadable, inconsistent, or earlier-layout record is never repaired, migrated, or discarded because it does not show that no host effects occurred.',
    'Inspect the protected deployment directory and zfs.json; do not edit or delete evidence while another Qiln process may be active.',
    'Compare the actual host with the recorded deployment before any manual recovery.',
  ),
  ZFS_PREPARATION_UNRESOLVED: entry(
    'ZFS preparation has an unresolved step',
    'A fenced step has no verified outcome because it was interrupted, exited nonzero, or was not verified by a fresh inspection, and Qiln never replays or resumes it while an unresolved pool step blocks prepare, removal, disconnect, and volume handoff and any other blocks prepare and removal that must release the host over SSH.',
    'Review the displayed unresolved steps and resolve the host state outside Qiln; no command clears unresolved evidence.',
    'Do not edit or delete preparation evidence to bypass this state.',
  ),
  ZFS_STEP_FAILED: entry(
    'A ZFS preparation step did not complete reliably',
    'Each approved step is one fenced remote script whose displayed outcome is authoritative: a refused step had no effect, an uncertain one may have run partly or fully, and Qiln never replays, resumes, or rolls back either.',
    'After a refusal, correct the cause outside Qiln and run prepare again.',
    'After an uncertain outcome, inspect the host outside Qiln first; the step stays unresolved, and prepare and remove refuse to continue until it is resolved through a reviewed procedure.',
  ),
  ZFS_EXPORT_REQUIRED: entry(
    'The recorded ZFS pool must be cleanly exported first',
    'The deployment records a pool that is still imported or whose check could not run, and Qiln never removes a host or hands off its volume without a clean export because that could force a later import.',
    'Run qiln aws deployment remove, which releases Incus when needed and then unmounts and exports the pool under its own approval. If the pool is recorded as imported but absent from the host, run prepare first.',
    'If the host cannot be reached, clean it up manually outside Qiln; Qiln never forces an export.',
  ),
})
