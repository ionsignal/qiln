import { entry } from '../define'

export const awsIncusDiagnostics = Object.freeze({
  AWS_INCUS_INSPECTION_FAILED: entry(
    'Incus inspection did not complete reliably',
    'The fixed read-only inspection returned missing or malformed output, so the command stopped; the inspection changes nothing, and steps completed earlier in the run are retained.',
    'Review the displayed reason, then confirm the guest baseline with qiln aws deployment verify.',
    'Run prepare again; Qiln does not retry or accept partial inspection output.',
  ),
  AWS_INCUS_PLAN_REFUSED: entry(
    'Incus preparation is not supported for this host state',
    'The host or the retained evidence conflicts with what this stage may change, so no further step was started; Qiln never overwrites configuration, edits the subordinate-ID files, changes package builds, or wipes retained state.',
    'Review each displayed reason and resolve the host condition outside Qiln.',
    'Run prepare again; it inspects the host from scratch and asks for a new approval.',
  ),
  AWS_INCUS_STEP_FAILED: entry(
    'An Incus preparation step did not complete reliably',
    'Each approved step is one fenced remote script whose displayed outcome is authoritative: a refused step had no effect, an uncertain one may have run partly or fully, and Qiln never replays, resumes, or rolls back either.',
    'After a refusal, correct the cause outside Qiln and run prepare again.',
    'After an uncertain outcome, inspect the host outside Qiln first; the step stays unresolved and blocks prepare until it is resolved through a reviewed procedure.',
  ),
  AWS_INCUS_PREPARATION_UNRESOLVED: entry(
    'Incus preparation has an unresolved step or unreleased storage',
    'A fenced Incus step has no verified outcome, or Incus was opened without a later verified release, so the daemon may still hold the pool and prepare and, depending on the step, removal, disconnect, or volume handoff stay blocked.',
    'Review the displayed Incus storage state and unresolved steps, and clean up the host outside Qiln; no command clears unresolved evidence.',
    'If Incus was opened and no release is recorded, run qiln aws deployment remove; if its units are inactive without a verified release, run prepare first to reopen it.',
  ),
  AWS_INCUS_STATE_INVALID: entry(
    'Incus preparation evidence is unsafe or incompatible',
    'The deployment’s incus.json must keep its supported schema, ownership, permissions, and binding to the deployment record, and an unreadable or inconsistent one is never repaired, migrated, or discarded, because it does not show that no host effects occurred.',
    'Inspect the protected deployment directory and incus.json; do not edit or delete evidence while another Qiln process may be active.',
    'Compare the actual host with the recorded deployment before any manual recovery.',
  ),
})
