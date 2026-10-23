import { entry } from './define'

export const zfsDiagnostics = Object.freeze({
  ZFS_INSPECTION_FAILED: entry(
    'ZFS inspection did not complete reliably',
    'Qiln runs one fixed read-only inspection script on the host and validates each section of its output before planning anything or verifying a step. The displayed reason names what was missing, malformed, or out of range. The inspection itself changes nothing. Steps that were approved and completed earlier in the same run are retained as evidence and are not undone.',
    'Review the displayed reason.',
    'Confirm that the guest baseline still passes with qiln aws deployment verify, then run prepare again.',
    'Qiln does not retry or accept partial inspection output.',
  ),
  ZFS_PLAN_REFUSED: entry(
    'ZFS preparation is not supported for this host state',
    'Qiln plans ZFS preparation only for an Ubuntu-packaged ZFS module that matches the running kernel and a recorded EBS data volume that is either blank or holds the pool recorded for it. Each displayed reason is a condition that was observed or could not be confirmed. Qiln does not install kernels or modules, wipe, repair, or adopt existing storage, force an import, or work around conflicting configuration, and no further step was started. Steps approved and completed earlier in the same run are retained as evidence and are not undone.',
    'Review each displayed reason.',
    'Resolve conditions on the host outside Qiln through an explicitly reviewed procedure, then run prepare again.',
    'Do not wipe or repartition the data volume to force a plan; an unexpected signature may be data that should be kept.',
  ),
  ZFS_REBOOT_REQUIRED: entry(
    'The host asks for a reboot before ZFS preparation',
    'The host reports a pending reboot, so the running kernel and installed packages may not match what a later preparation step would observe. Qiln never reboots the host or continues from a stale observation, and no further step was started. Steps approved and completed earlier in the same run are retained as evidence and are not undone.',
    'Reboot the host through an approved procedure outside Qiln.',
    'Run prepare again; it inspects the host from scratch.',
  ),
  ZFS_STATE_INVALID: entry(
    'ZFS preparation evidence is unsafe or incompatible',
    'The deployment’s zfs.json must keep its exact supported schema, ownership, permissions, size bound, and binding to the deployment record. An unreadable or inconsistent record does not establish that no host effects occurred. Evidence is never repaired, migrated, adopted, or discarded automatically, and work that could conflict with possible preparation effects is refused.',
    'Inspect the protected deployment directory and its zfs.json.',
    'Do not edit or delete preparation evidence or lock files while another Qiln process may be active.',
    'Compare the actual host with the recorded deployment before any manual recovery.',
  ),
  ZFS_PREPARATION_UNRESOLVED: entry(
    'ZFS preparation has an unresolved step',
    'A fenced preparation step has no verified outcome: it was interrupted, completed with a nonzero exit, or its result was not verified by a fresh inspection. Interrupted remote work may already have completed, and a nonzero exit does not show that nothing changed. Qiln never replays or resumes such a step.',
    'Review the displayed unresolved steps.',
    'Inspect the host outside Qiln and resolve its state through an explicitly reviewed procedure. Qiln has no command that clears unresolved evidence in this release.',
    'Do not edit or delete preparation evidence to bypass this state.',
  ),
  ZFS_STEP_FAILED: entry(
    'A ZFS preparation step did not complete reliably',
    'Qiln runs each approved preparation step as one fenced remote script and retains its outcome. The displayed outcome is authoritative: a refused step had no effect, while an uncertain step may have run partly or fully, and an exit code other than zero does not show that nothing changed. Qiln never replays, resumes, or rolls back a step, and an approval authorizes only the steps of the plan displayed with it. Package installation can also load the ZFS module and start ZFS services as part of the package’s own configuration, and a pool create, import, or export may have changed the pool even when its outcome is unknown.',
    'Review the displayed step, outcome, and reason.',
    'After a refusal, correct the cause outside Qiln, then run prepare again; it inspects the host from scratch and asks for a new approval.',
    'After an uncertain outcome, inspect the host outside Qiln before anything else. The step stays unresolved, and prepare and remove refuse to continue until it is resolved through an explicitly reviewed procedure.',
  ),
  ZFS_EXPORT_REQUIRED: entry(
    'The recorded ZFS pool must be cleanly exported first',
    'The deployment records a pool that is imported on the host. Removing the host or handing its data volume to a later deployment without a clean export can leave a pool that needs forced import, which Qiln never performs. Before any AWS removal step has started, remove checks the recorded pool over SSH and exports it under its own approval; once removal has started, SSH is no longer used. This state means that export was not completed, the pool is still recorded as imported, or the check could not run. This command changed nothing.',
    'Review the displayed pool evidence with qiln aws deployment status.',
    'Run qiln aws deployment remove, which checks and exports the pool before any AWS removal call. If the pool is recorded as imported but absent from the host, run prepare first, which imports it again.',
    'Qiln never forces an export, and never removes the host while its pool is recorded as imported. If the host cannot be reached, the deployment must be cleaned up manually outside Qiln.',
  ),
})
