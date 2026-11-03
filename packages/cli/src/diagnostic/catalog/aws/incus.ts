import { entry } from '../define'

export const awsIncusDiagnostics = Object.freeze({
  AWS_INCUS_INSPECTION_FAILED: entry(
    'Incus inspection did not complete reliably',
    'Qiln validates every section of one fixed read-only inspection before planning or verifying a step, so missing or malformed output stops the command. The displayed reason names what was missing; the inspection changes nothing, and steps completed earlier in the run are retained, not undone.',
    'Review the displayed reason, then confirm the guest baseline with qiln aws deployment verify.',
    'Run prepare again; Qiln does not retry or accept partial inspection output.',
  ),
  AWS_INCUS_PLAN_REFUSED: entry(
    'Incus preparation is not supported for this host state',
    'The host or the retained evidence conflicts with what this stage may change, so no further step was started. Qiln never overwrites conflicting configuration, edits the subordinate-ID files, upgrades, downgrades, or swaps package builds, or wipes retained state, and steps completed earlier in the run are retained as evidence.',
    'Review each displayed reason and resolve the host condition outside Qiln.',
    'Run prepare again; it inspects the host from scratch and asks for a new approval.',
  ),
  AWS_INCUS_STEP_FAILED: entry(
    'An Incus preparation step did not complete reliably',
    'Each approved step is one fenced remote script, and the displayed outcome is authoritative: a refused step had no effect, while an uncertain step may have run partly or fully. Qiln never replays, resumes, or rolls back a step.',
    'After a refusal, correct the cause outside Qiln and run prepare again.',
    'After an uncertain outcome, inspect the host outside Qiln first; the step stays unresolved and blocks prepare until it is resolved through a reviewed procedure.',
  ),
  AWS_INCUS_PREPARATION_UNRESOLVED: entry(
    'Incus preparation has an unresolved step or unreleased storage',
    'A fenced Incus step has no verified outcome, or Incus was opened and no later verified release is recorded, so the daemon may still hold the pool. Qiln never replays or resumes such a step, and an unresolved step blocks prepare and, depending on the step, removal, disconnect, or volume handoff.',
    'Review the displayed Incus storage state and unresolved steps, and clean up the host outside Qiln; no command clears unresolved evidence.',
    'If Incus was opened and no release is recorded, run qiln aws deployment remove; if its units are inactive without a verified release, run prepare first to reopen it.',
  ),
  AWS_INCUS_STATE_INVALID: entry(
    'Incus preparation evidence is unsafe or incompatible',
    'The deployment’s incus.json must keep its supported schema, ownership, permissions, and binding to the deployment record. An unreadable or inconsistent record does not show that no host effects occurred, and it is never repaired, migrated, or discarded.',
    'Inspect the protected deployment directory and incus.json; do not edit or delete evidence while another Qiln process may be active.',
    'Compare the actual host with the recorded deployment before any manual recovery.',
  ),
})
