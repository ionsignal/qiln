import { entry } from '../define'

export const awsIncusDiagnostics = Object.freeze({
  AWS_INCUS_INSPECTION_FAILED: entry(
    'Incus inspection did not complete reliably',
    'Qiln runs one fixed inspection script on the host and validates each section of its output before planning anything or verifying a step. That covers the APT repository files and package lists, the Incus units (read as machine-readable load, unit-file, and activation states, so an absent unit is told apart from an inactive one) and TCP listeners, the host network, the administrator account’s Incus group membership, the ZFS pool, and, only while an Incus socket is active, the Incus API. The displayed reason names what was missing, malformed, or out of range. Reading the API of an active socket can start the daemon through socket activation; the inspection changes nothing else. Steps that were approved and completed earlier in the same run are retained as evidence and are not undone.',
    'Review the displayed reason.',
    'Confirm that the guest baseline still passes with qiln aws deployment verify, then run prepare again.',
    'Qiln does not retry or accept partial inspection output.',
  ),
  AWS_INCUS_PLAN_REFUSED: entry(
    'Incus preparation is not supported for this host state',
    'Qiln prepares Incus only on a host whose recorded ZFS pool is imported and ready, with no unsupported Incus package, no conflicting APT source or keyring file, and, for a first initialization, a pristine daemon: no server configuration, storage pool, managed network, profile content, instance, or image, no dataset other than the pool root, no overlapping host route or address, and no TCP listener. A pool that holds retained Incus datasets is refused because restoration is not supported, and Qiln never adopts, wipes, or converges existing Incus state. An initialized baseline that drifted from its retained preseed is refused rather than repaired. The final socket-access stage is refused when the incus-admin group does not exist, because the packages create it and Qiln never creates groups. Qiln never starts units, so an Incus daemon whose sockets were stopped by a release stays unreadable until an operator restarts it outside Qiln. No further step was started. Steps approved and completed earlier in the same run are retained as evidence and are not undone.',
    'Review each displayed reason.',
    'Resolve conditions on the host outside Qiln through an explicitly reviewed procedure, then run prepare again.',
    'To avoid retained Incus datasets, create a new deployment with a new data volume. Qiln never wipes the pool to force a plan.',
  ),
  AWS_INCUS_STEP_FAILED: entry(
    'An Incus preparation step did not complete reliably',
    'Qiln runs each approved preparation step as one fenced remote script and retains its outcome. The displayed outcome is authoritative: a refused step had no effect, while an uncertain step may have run partly or fully, and an exit code other than zero does not show that nothing changed. A refused repository step can mean that curl is missing on the host, that the signing key download failed or exceeded its size limit, or that the downloaded key does not match the reviewed SHA-256; nothing was installed in any of those cases, Qiln installs no prerequisites, and a rotated key needs a new reviewed digest in a new Qiln release. A refused access step means the incus-admin group or the administrator account is missing, or the account is root; no membership was changed. Qiln never replays, resumes, or rolls back a step, and an approval authorizes only the steps of the plan displayed with it. Package installation can start Incus units as part of the package’s own configuration, and an initialization or release may have changed the daemon and the pool even when its outcome is unknown.',
    'Review the displayed step, outcome, and reason.',
    'After a refusal, correct the cause outside Qiln, then run prepare again; it inspects the host from scratch and asks for a new approval.',
    'After an uncertain outcome, inspect the host outside Qiln before anything else. The step stays unresolved, and prepare refuses to continue until it is resolved through an explicitly reviewed procedure.',
  ),
  AWS_INCUS_PREPARATION_UNRESOLVED: entry(
    'Incus preparation has an unresolved step or unreleased storage',
    'A fenced Incus step has no verified outcome: it was interrupted, completed with a nonzero exit, or its result was not verified by a fresh inspection. Interrupted remote work may already have completed, and Qiln never replays or resumes such a step. Recovery depends on the step. For a host whose Incus was never initialized by Qiln, an unresolved repository, package-list, or package step blocks further prepare but not removal, disconnect, or volume handoff; recover by removing the host and creating a new one that reuses the retained data volume, because the Incus evidence belongs to the deployment and the new host starts clean. Once Incus was initialized, stopping it for removal needs every earlier step resolved, so any unresolved step then refuses removal, before any connection or AWS call, and needs manual cleanup outside Qiln. Removal that must release the host over SSH likewise refuses any unresolved ZFS step. A socket-access step only follows initialization, so an unresolved one blocks prepare and that stop, but not disconnect or volume handoff. An unresolved initialize or release step may have left Incus data on the pool or the daemon running, so it blocks prepare, removal, disconnect, and volume handoff, and needs manual cleanup outside Qiln. The same refusal applies when Incus was initialized and no later release or observed inactivity is recorded, because the pool must not be exported or handed off while the daemon may hold it. An observed inactivity is point-in-time evidence and never settles an unresolved step.',
    'Review the displayed Incus storage state and unresolved steps.',
    'For storage steps, inspect and clean up the host outside Qiln through an explicitly reviewed procedure. Qiln has no command that clears unresolved evidence in this release.',
    'When Incus was initialized and no release is recorded, run qiln aws deployment remove, which checks Incus freshly and, when it is not already inactive, stops it under its own approval before the ZFS export.',
    'Do not edit or delete preparation evidence to bypass this state.',
  ),
  AWS_INCUS_STATE_INVALID: entry(
    'Incus preparation evidence is unsafe or incompatible',
    'The deployment’s incus.json must keep its exact supported schema, ownership, permissions, size bound, and binding to the deployment record, and every retained preseed must still match its approved digest and the supported preseed shape. An unreadable or inconsistent record does not establish that no host effects occurred. Evidence is never repaired, migrated, adopted, or discarded automatically, and work that could conflict with possible preparation effects is refused.',
    'Inspect the protected deployment directory and its incus.json.',
    'Do not edit or delete preparation evidence or lock files while another Qiln process may be active.',
    'Compare the actual host with the recorded deployment before any manual recovery.',
  ),
})
