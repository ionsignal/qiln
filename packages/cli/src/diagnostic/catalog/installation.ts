import { entry, preservePostgresStep } from './define'

export const installationDiagnostics = Object.freeze({
  INVALID_IMAGE_SELECTOR: entry(
    'Image selector is malformed',
    'Image selection must identify one unambiguous local alias or full lowercase SHA-256 fingerprint.',
    'Supply a non-empty selector without surrounding whitespace or control characters.',
  ),
  IMAGE_FINGERPRINT_NOT_LOWERCASE: entry(
    'Image fingerprint must be lowercase',
    'Qiln persists one canonical immutable image identity and does not silently normalize operator input.',
    'Supply the same full 64-character fingerprint in lowercase.',
  ),
  IMAGE_FINGERPRINT_MISMATCH: entry(
    'Resolved image does not match the selected fingerprint',
    'The installation pin must identify the exact content-addressed image returned by Incus.',
    'Inspect the local image store and image metadata manually.',
  ),
  IMAGE_TYPE_INCOMPATIBLE: entry(
    'Selected image is not a container image',
    'The development orchestrator is an Incus container, not a virtual machine.',
    'Select or import a trusted local container image.',
  ),
  IMAGE_ARCHITECTURE_INCOMPATIBLE: entry(
    'Selected image architecture does not match the host',
    'The installer requires provider metadata for the host’s native architecture (x86_64 or aarch64) and does not accept foreign-architecture emulation.',
    'Select an image built for the architecture shown in the diagnostic facts.',
  ),
  IMAGE_ALIAS_NOT_FOUND: entry(
    'Local image alias was not found',
    'The --image workflow resolves existing local images only. It never pulls an image from a remote server.',
    'Select an existing local alias or full fingerprint, or explicitly import the trusted image.',
  ),
  IMAGE_ALIAS_TARGET_INVALID: entry(
    'Image alias target is malformed',
    'The selected alias must resolve to one canonical full lowercase fingerprint.',
    'Repair the local alias or select the full image fingerprint explicitly.',
  ),
  IMAGE_PIN_CONFLICT: entry(
    'Image pin conflicts with this installation',
    'The --image workflow verifies an existing local image. It never replaces the immutable image pin recorded for this installation.',
    'Re-run with the installed fingerprint.',
    'Use the explicit split-image workflow only for an intentional replacement.',
  ),
  IMAGE_NOT_FOUND: entry(
    'Selected local image was not found',
    'Qiln does not pull or automatically replace an image selected through --image.',
    'Select an existing trusted local image or use the explicit split-image import workflow.',
  ),
  INVALID_IMAGE_FINGERPRINT: entry(
    'Installation fingerprint is malformed',
    'Qiln persists only full lowercase SHA-256 provider image identities.',
    'Reconcile the selected local image before retrying.',
  ),
  MANAGED_IMAGE_ALIAS_TARGET_INVALID: entry(
    'Managed image alias target is malformed',
    'Explicit replacement must identify the exact old image before deleting it.',
    'Inspect and repair the managed image alias manually.',
  ),
  MANAGED_IMAGE_ALIAS_TARGET_MISSING: entry(
    'Managed image alias target could not be verified',
    'Qiln will not delete an unverified or ambiguous image target.',
    'Inspect the local image and alias state manually.',
  ),
  MANAGED_IMAGE_ALIAS_CONFLICT: entry(
    'Managed image alias points to an unexpected image',
    'Qiln does not implicitly retarget an unexpected alias or import into conflicting alias state.',
    'Inspect the actual image and alias state before retrying.',
  ),
  MANAGED_IMAGE_ALIAS_VERIFICATION_FAILED: entry(
    'Managed image alias could not be verified',
    'The selected content-addressed image and managed alias must both converge before installation state is committed.',
    'Inspect local image operations and aliases before retrying.',
  ),
  IMPORTED_IMAGE_NOT_FOUND: entry(
    'Computed image is absent after convergence',
    'Qiln cannot commit a pin that does not resolve to the exact provider image.',
    'Inspect image operations and the local image store before retrying.',
  ),
  FINAL_IMAGE_ALIAS_MISMATCH: entry(
    'Managed image alias changed during convergence',
    'Split-image convergence requires the alias and persisted image identity to remain consistent.',
    'Inspect concurrent image and alias changes, then re-run qiln installation configure for the same target.',
  ),
  INVALID_SOURCE_CHECKOUT: entry(
    'Source checkout is unavailable or invalid',
    'The selected source must be a readable canonical checkout directory with a supported root package descriptor.',
    'Select the root of the intended local Qiln Git checkout and repair the indicated entry if necessary.',
  ),
  SOURCE_NOT_ACCESSIBLE: entry(
    'Source checkout is not accessible',
    'Source validation runs entirely with the invoking developer’s filesystem permissions.',
    'Provide a readable local checkout accessible to the developer.',
  ),
  SOURCE_NOT_GIT_CHECKOUT: entry(
    'Source is not a valid Git working tree',
    'The host checkout remains the canonical repository for the development workflow.',
    'Pass the root of a valid local Qiln Git checkout.',
  ),
  SOURCE_NOT_CHECKOUT_ROOT: entry(
    'Source path is not the checkout root',
    'The source device requires one deterministic repository root.',
    'Use the Git top-level directory shown in the diagnostic facts.',
  ),
  INVALID_GIT_METADATA: entry(
    'Git metadata entry is unsupported',
    'Qiln accepts normal checkouts and worktrees, but not symbolic or special-file metadata entries.',
    'Repair or recreate the checkout before retrying.',
  ),
  INVALID_SOURCE_PACKAGE: entry(
    'Source package descriptor is invalid',
    'The root package.json must be a bounded, non-empty regular file containing valid JSON.',
    'Repair package.json in the selected checkout.',
  ),
  SOURCE_NOT_QILN_PACKAGE: entry(
    'Source does not identify the Qiln package',
    'Qiln will not attach an unrelated source tree as its development checkout.',
    'Select the repository whose root package.json has name qiln.',
  ),
  INVALID_SOURCE_ROOT: entry(
    'Source root cannot be attached to the orchestrator',
    'The source device requires a canonical absolute non-root path without unsupported characters.',
    'Select the canonical Qiln Git checkout root with --source.',
  ),
  INSTALLATION_HOST_INSPECTION_FAILED: entry(
    'Target host inspection did not complete reliably',
    'Qiln runs one fixed read-only inspection script on the target and validates each section of its output before judging the host or its checkout. The displayed reason names what was missing, malformed, or out of range. The inspection changes nothing and runs without elevated privilege.',
    'Review the displayed reason.',
    'Confirm that the target is reachable and passes its baseline checks, then try again.',
    'Qiln does not retry or accept partial inspection output.',
  ),
  INSTALLATION_TARGET_CAPACITY: entry(
    'Target host has less memory than the installation limit',
    'The layout limits the orchestrator to more memory than the target reports in total. Qiln does not lower the limit, change the layout of an installation, or resize the host. The check compares the configured limit with total memory only: it does not establish free capacity or runtime readiness. Nothing was changed.',
    'Review the memory limit and the memory the target reports.',
    'Use a target with more memory. Resolve the host size outside Qiln.',
  ),
  INSTALLATION_STATE_REQUIRED: entry(
    'Installation image pin is unavailable',
    'Credentials may be delivered only to an instance matching the persisted image identity.',
    'Re-run qiln installation configure for the same target to reconcile the selected image and installation state.',
  ),
  INSTALLER_LEGACY_STATE: entry(
    'Installer state uses a superseded layout',
    'Earlier versions kept the installation record, credentials, and lock directly in the Qiln state directory. Installations now live in named directories, each the single authority for its own credentials. Qiln never reads, copies, migrates, or deletes the earlier entries, so two credential authorities can never exist.',
    'Review the listed entries in the Qiln state directory.',
    'Remove them manually once you no longer need them, then re-run the command. An orchestrator whose credentials are no longer available locally is refused until it is reviewed manually.',
    preservePostgresStep,
  ),
  INSTALLATION_HOST_UNIDENTIFIED: entry(
    'Local host identity is unavailable',
    'Installation records are bound to this machine through an application-specific digest of /etc/machine-id. The identifier was unreadable or malformed. The binding is evidence of identity and not attestation, and the raw identifier is never retained or displayed.',
    'Restore a readable, valid /etc/machine-id through normal host administration.',
  ),
  INSTALLATION_BINDING_MISMATCH: entry(
    'Installation record does not match this invocation',
    'A retained installation record binds one host, architecture, layout, and checkout path. Qiln refuses a different one rather than rebinding, replacing, or migrating the record.',
    'Use the original host, source checkout, and layout, or review the retained state manually.',
    preservePostgresStep,
  ),
  INSTALLATION_HOST_REGISTERED: entry(
    'Another installation is already registered for this host',
    'This release supports one installation per host, because the orchestrator instance name is fixed. Qiln never merges, renames, or replaces an existing installation record.',
    'Use the installation that is already registered for this host.',
    'Review and remove the other installation state manually only if it is obsolete.',
    preservePostgresStep,
  ),
  AWS_INSTALLATION_BINDING_REFUSED: entry(
    'Deployment is not ready for installation',
    'Installation consumes retained deployment evidence and never authenticates to AWS or probes the host to fill a gap. It needs a retained host-key pin, a recorded ZFS pool verified imported with its scrub timer, an Incus initialization verified and not released, no unresolved preparation step, and a bridge address that its layout derivation accepts. The evidence is point-in-time, and a live inspection precedes any later change.',
    'Run qiln aws deployment verify to retain the host-key pin, and qiln aws deployment prepare to complete ZFS and Incus preparation.',
    'Qiln never restarts Incus after removal has stopped it. Restart it outside Qiln only after review.',
  ),
  ORCHESTRATOR_INSTANCE_REQUIRED: entry(
    'Stopped orchestrator is unavailable',
    'Credential delivery requires an exact compatible stopped target instance.',
    'Re-run qiln installation configure for the same target to reconcile the development orchestrator.',
  ),
  ORCHESTRATOR_IMAGE_SIGNATURE_MISMATCH: entry(
    'Orchestrator does not match the persisted image',
    'Qiln never delivers credentials to an instance whose base-image signature differs from the installation pin.',
    'Review and remove only the incompatible stopped instance manually, then re-run convergence.',
    preservePostgresStep,
  ),
  FINAL_INSTALLATION_STATE_MISSING: entry(
    'Installation state disappeared during convergence',
    'A successful installation requires one authoritative persisted image identity.',
    'Inspect the protected state directory and any concurrent changes before retrying.',
  ),
  FINAL_INSTANCE_STATE_MISMATCH: entry(
    'Instance changed during credential convergence',
    'Credential delivery must preserve unrelated writable instance configuration.',
    'Inspect concurrent configuration changes, then re-run qiln installation configure for the same target.',
  ),
  INCOMPATIBLE_ORCHESTRATOR_INSTANCE: entry(
    'Existing orchestrator conflicts with the installation',
    'Qiln will not start, stop, rebuild, delete, or partially repair an incompatible retained instance.',
    'Review the differences and remove only the incompatible stopped instance manually if replacement is intended.',
    preservePostgresStep,
    'Re-run with the intended source checkout and image.',
  ),
  INVALID_INSTALLATION_STATE: entry(
    'Installation state is invalid or incompatible',
    'The record must match the supported schema exactly: version, name, project, instance name, host binding, architecture, layout digest, checkout path, and an image fingerprint that is absent or a full lowercase SHA-256. A permitted write changes only the image pin.',
    'Review the CLI version and inspect the installation record manually before recovery.',
    'Do not discard retained credentials or persistent data.',
  ),
  ORCHESTRATOR_INSTANCE_VERIFICATION_FAILED: entry(
    'Orchestrator is absent after creation',
    'Qiln cannot report success without re-reading the exact stopped instance after its operation completes.',
    'Inspect the instance inventory and operation history before retrying.',
  ),
  INSTALLATION_PLAN_CHANGED: entry(
    'Installation changed after its plan was displayed',
    'The host no longer matches the plan that was approved, so nothing was applied for that plan.',
    'Re-run the command to review the current plan.',
  ),
  INSTALLATION_STEP_FAILED: entry(
    'Installation step did not complete',
    'An Incus request was refused or its outcome is uncertain. A refused request had no effect. An uncertain one may have changed the host in part or in full, and Qiln never replays it.',
    'Inspect the images, network, volume, and instance named in the diagnostic facts before retrying.',
    preservePostgresStep,
  ),
  INSTALLATION_UNRESOLVED: entry(
    'Installation has an unresolved step',
    'A previous configuration step has an effect that is unknown. Qiln never replays, resumes, or clears it.',
    'Inspect the Incus daemon, images, and network named in the diagnostic facts manually.',
    preservePostgresStep,
  ),
  INSTALLATION_EVIDENCE_INVALID: entry(
    'Installation evidence is invalid or incompatible',
    'Configuration evidence must match its installation record, the approved plan shape, and its step and operation history. It is never repaired or rebound.',
    'Review configure.json in the installation directory before any recovery.',
    preservePostgresStep,
  ),
  INSTALLATION_NOT_VERIFIED: entry(
    'Installation was not verified after configuration',
    'Qiln reports success only after a fresh observation agrees with the approved plan.',
    'Inspect the image, network, volume, instance, and credentials, then re-run the command.',
    preservePostgresStep,
  ),
})
