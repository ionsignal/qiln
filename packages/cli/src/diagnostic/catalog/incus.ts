import { entry, preservePostgresStep } from './define'

const inspectIncusStep = 'Inspect the local Incus daemon, its operations, and the managed resources before retrying.'
const restoreIncusAccessStep =
  'Verify the daemon and the developer’s approved local Incus access. Start a new login session after changing group membership.'

export const incusDiagnostics = Object.freeze({
  INVALID_INCUS_SOCKET: entry(
    'Local Incus endpoint is not a Unix socket',
    'The installer accepts only the documented local Unix API, not a redirected file or remote endpoint.',
    'Inspect the Incus installation and restore its local daemon socket manually.',
  ),
  INCUS_SOCKET_UNAVAILABLE: entry(
    'Local Incus socket is unavailable',
    'Qiln does not install, enable, start, or repair the Incus service.',
    'Inspect the Incus installation and enable the daemon manually after review.',
    restoreIncusAccessStep,
  ),
  INCUS_ACCESS_UNAVAILABLE: entry(
    'Local Incus API could not be reached',
    'Qiln uses the invoking developer’s existing authority and never invokes sudo or a privileged helper.',
    restoreIncusAccessStep,
  ),
  INCUS_API_REJECTED: entry(
    'Local Incus API rejected the developer',
    'The installer requires existing local administrative authority in the configured project.',
    restoreIncusAccessStep,
  ),
  INCUS_PROTOCOL_INCOMPATIBLE: entry(
    'Incus returned an incompatible response',
    'Qiln cannot infer safe installation state from a response that does not satisfy its supported API contract.',
    'Verify that the socket belongs to a healthy, supported Incus daemon.',
    inspectIncusStep,
  ),
  INCOMPATIBLE_INCUS_SERVER: entry(
    'Endpoint is not a full Incus server',
    'Qiln requires the local full-featured Incus daemon, not an image-only endpoint or another implementation.',
    'Restore the documented socket connection to the supported local daemon.',
  ),
  INCOMPATIBLE_INCUS_API: entry(
    'Incus API version is incompatible',
    'The installer supports the stable Incus 1.0 API contract.',
    'Run a supported stable Incus daemon.',
  ),
  UNSUPPORTED_INCUS_DAEMON_VERSION: entry(
    'Running Incus version is unsupported',
    'The running daemon must satisfy the installer’s version policy independently of installed package metadata.',
    'Manually install and start a supported Incus release.',
  ),
  INCUS_CLIENT_UNTRUSTED: entry(
    'Developer is not trusted by Incus',
    'The installer requires pre-provisioned authority to inspect and manage its local resources.',
    restoreIncusAccessStep,
  ),
  INCUS_PROJECT_INCOMPATIBLE: entry(
    'Incus project scope is incompatible',
    'The development installer manages resources only in its configured project.',
    'Use an approved local administrative session with access to that project.',
  ),
  INCUS_ARCHITECTURE_INCOMPATIBLE: entry(
    'Incus does not report the host architecture',
    'The installer requires native container support for the host’s own architecture (x86_64 or aarch64) and does not rely on emulation.',
    'Use an Incus daemon that reports the host’s native architecture.',
  ),
  INCUS_CAPABILITY_MISSING: entry(
    'Incus is missing required installer capabilities',
    'The installer requires shifted source disks, systemd credential delivery, and verifiable operation completion before mutations.',
    'Install and run a supported daemon exposing every listed API extension.',
  ),
  INCUS_OPERATION_INDETERMINATE: entry(
    'Incus operation result is indeterminate',
    'The local wait deadline does not establish success or failure. The operation may still be running or may already have completed; Qiln will not cancel it automatically.',
    'Inspect the operation and actual resource state.',
    'Re-run qiln up to reconcile without assuming that rollback occurred.',
  ),
  INCUS_OPERATION_FAILED: entry(
    'Incus operation completed unsuccessfully',
    'The background operation did not reach the required success state.',
    inspectIncusStep,
    'Reconcile from actual provider state without assuming that partial effects were rolled back.',
  ),
  INCUS_API_UNAVAILABLE: entry(
    'Incus request did not complete reliably',
    'Qiln does not have a complete installation view. A failed response does not establish that a requested mutation had no effect.',
    restoreIncusAccessStep,
    inspectIncusStep,
  ),
  INCUS_ACCESS_DENIED: entry(
    'Incus denied the requested operation',
    'Qiln cannot obtain additional authority through privilege escalation.',
    restoreIncusAccessStep,
  ),
  INCUS_UNEXPECTED_NOT_FOUND: entry(
    'Required Incus resource was not found',
    'This request required a verified resource rather than an optional lookup.',
    inspectIncusStep,
    'Re-run convergence using the actual local provider state.',
  ),
  INCUS_ETAG_CONFLICT: entry(
    'Incus resource changed during a guarded update',
    'Qiln will not replay a complete update body derived from stale provider state. Any permitted re-read and guarded retry has already been handled by the caller.',
    'Stop concurrent configuration changes, then re-run qiln up.',
  ),
  INCUS_API_REQUEST_REJECTED: entry(
    'Incus rejected the requested operation',
    'Qiln cannot safely continue from a rejected required API request.',
    'Inspect daemon health, project access, and the affected resources before retrying.',
  ),
  INCUS_INSPECTION_FAILED: entry(
    'Required Incus operation failed unexpectedly',
    'The resulting installation view may be incomplete or inconsistent.',
    inspectIncusStep,
    'Review the installed Qiln CLI version before retrying.',
  ),
  INCUS_NETWORK_RANGE_CONFLICT: entry(
    'Planned subnet overlaps an Incus network',
    'Creating the bridge would introduce conflicting routing or address allocation.',
    'Review and resolve the conflicting network range manually. Qiln will not modify the unrelated network.',
  ),
  INCOMPATIBLE_INCUS_NETWORK: entry(
    'Existing network conflicts with the installation',
    'Qiln does not overwrite or partially repair conflicting network ownership or configuration.',
    'Inspect the network and resolve the conflict manually while preserving unrelated workloads.',
  ),
  INCUS_NETWORK_VERIFICATION_FAILED: entry(
    'Managed network is absent after creation',
    'Qiln cannot create the orchestrator against an unverified network.',
    'Inspect the network inventory and daemon logs before retrying.',
  ),
  INCUS_STORAGE_POOL_MISSING: entry(
    'Required Incus storage pool is missing',
    'The installer requires an existing reviewed ZFS storage pool and does not configure host ZFS resources.',
    'Have an authorized operator create the required Incus ZFS pool after reviewing its host backing pool.',
  ),
  INCOMPATIBLE_INCUS_STORAGE_POOL: entry(
    'Incus storage pool is incompatible',
    'Qiln will not replace or partially repair a pool with conflicting provider state.',
    'Inspect the driver, status, and source of the existing pool and resolve the conflict manually.',
    preservePostgresStep,
  ),
  INCOMPATIBLE_POSTGRES_VOLUME: entry(
    'Existing PostgreSQL volume conflicts with the installation',
    'Qiln never replaces or modifies an incompatible persistent data volume automatically.',
    'Inspect the volume and resolve its naming or configuration conflict manually.',
    preservePostgresStep,
  ),
  POSTGRES_VOLUME_VERIFICATION_FAILED: entry(
    'PostgreSQL volume is absent after creation',
    'Qiln cannot attach an unverified persistent volume to the orchestrator.',
    'Inspect the storage inventory and daemon logs before retrying.',
  ),
})
