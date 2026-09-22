export interface DiagnosticDefinition {
  readonly title: string
  readonly explanation: string
  readonly steps: readonly string[]
}

function entry(title: string, explanation: string, ...steps: string[]): DiagnosticDefinition {
  return Object.freeze({
    title,
    explanation,
    steps: Object.freeze(steps),
  })
}

const recoverCredentials =
  'Inspect and recover the complete four-file local credential set before retrying. Do not regenerate individual credentials.'

const inspectIncus = 'Inspect the local Incus daemon, its operations, and the managed resources before retrying.'

const restoreAccess =
  'Verify the daemon and the developer’s approved local Incus access. Start a new login session after changing group membership.'

const preservePostgres = 'Preserve the PostgreSQL custom volume and its data during any manual recovery.'

export const catalog = Object.freeze({
  MISSING_HOST_TOOL: entry(
    'Required host tool is unavailable',
    'Qiln uses tools already installed on the host. It does not install packages or invoke privilege escalation.',
    'Install the indicated package manually after review, then return to an unprivileged developer session.',
  ),
  PACKAGE_QUERY_FAILED: entry(
    'Installed package could not be inspected',
    'The package query did not establish whether the required package is installed and compatible.',
    'Inspect and repair the local dpkg package database manually.',
  ),
  PACKAGE_VERSION_CHECK_FAILED: entry(
    'Incus package version could not be compared',
    'Qiln could not establish whether the installed package is within its supported version range.',
    'Inspect the local dpkg installation and repair its package metadata manually.',
  ),
  INCUS_PACKAGE_MISSING: entry(
    'Supported Incus server package is missing',
    'Qiln requires a preinstalled Incus server and does not bootstrap the host daemon.',
    'Install a supported Incus server through the reviewed Ubuntu or Zabbly procedure.',
    'Enable the service manually and start a new login session if group membership changes.',
  ),
  UNSUPPORTED_INCUS_PACKAGE_VERSION: entry(
    'Incus package version is unsupported',
    'The installed package is outside the installer’s supported range. Package metadata alone does not establish publisher provenance.',
    'Review the package source and manually install a supported Incus release.',
  ),
  UNSUPPORTED_HOST_PLATFORM: entry(
    'Host platform is unsupported',
    'The local Incus, ZFS, and Unix-socket installation boundary requires Linux.',
    'Run Qiln on the supported Ubuntu developer host.',
  ),
  HOST_RELEASE_UNAVAILABLE: entry(
    'Host release could not be identified',
    'Qiln must establish the supported operating-system release before running dependent checks.',
    'Restore readable, valid /etc/os-release metadata on the supported Ubuntu host.',
  ),
  UNSUPPORTED_UBUNTU_RELEASE: entry(
    'Ubuntu release is unsupported',
    'The installer deliberately accepts only its configured Ubuntu release.',
    'Use the supported host release shown in the diagnostic facts.',
  ),
  UNSUPPORTED_HOST_ARCHITECTURE: entry(
    'Host architecture is unsupported',
    'The installer requires native AMD64 containers and does not rely on foreign-architecture emulation.',
    'Run Qiln on a supported x86_64/AMD64 host.',
  ),
  UNSUPPORTED_KERNEL_VERSION: entry(
    'Running kernel does not meet the installation policy',
    'The selected Incus release and installation policy require the configured kernel baseline.',
    'Manually install and boot an approved kernel that meets the requirement.',
  ),
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
    'Selected image architecture is unsupported',
    'The installer requires native x86_64 provider metadata and does not accept foreign-architecture emulation.',
    'Select an image whose Incus architecture is x86_64.',
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
  INVALID_INCUS_SOCKET: entry(
    'Local Incus endpoint is not a Unix socket',
    'The installer accepts only the documented local Unix API, not a redirected file or remote endpoint.',
    'Inspect the Incus installation and restore its local daemon socket manually.',
  ),
  INCUS_SOCKET_UNAVAILABLE: entry(
    'Local Incus socket is unavailable',
    'Qiln does not install, enable, start, or repair the Incus service.',
    'Inspect the Incus installation and enable the daemon manually after review.',
    restoreAccess,
  ),
  INCUS_ACCESS_UNAVAILABLE: entry(
    'Local Incus API could not be reached',
    'Qiln uses the invoking developer’s existing authority and never invokes sudo or a privileged helper.',
    restoreAccess,
  ),
  INCUS_API_REJECTED: entry(
    'Local Incus API rejected the developer',
    'The installer requires existing local administrative authority in the configured project.',
    restoreAccess,
  ),
  INCUS_PROTOCOL_INCOMPATIBLE: entry(
    'Incus returned an incompatible response',
    'Qiln cannot infer safe installation state from a response that does not satisfy its supported API contract.',
    'Verify that the socket belongs to a healthy, supported Incus daemon.',
    inspectIncus,
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
    restoreAccess,
  ),
  INCUS_PROJECT_INCOMPATIBLE: entry(
    'Incus project scope is incompatible',
    'The development installer manages resources only in its configured project.',
    'Use an approved local administrative session with access to that project.',
  ),
  INCUS_ARCHITECTURE_INCOMPATIBLE: entry(
    'Incus does not report the required architecture',
    'The installer requires native x86_64 container support.',
    'Use a supported x86_64 Incus host without relying on emulation.',
  ),
  HOST_NETWORK_INSPECTION_FAILED: entry(
    'Host network information could not be decoded',
    'Qiln could not establish whether the planned subnet conflicts with host routes or addresses.',
    'Inspect the host network configuration and repair the iproute2 installation if necessary.',
  ),
  INCUS_NETWORK_RANGE_CONFLICT: entry(
    'Planned subnet overlaps an Incus network',
    'Creating the bridge would introduce conflicting routing or address allocation.',
    'Review and resolve the conflicting network range manually. Qiln will not modify the unrelated network.',
  ),
  HOST_ROUTE_INSPECTION_FAILED: entry(
    'Host IPv4 routes could not be inspected',
    'Qiln cannot establish that the planned bridge range is free of host routing conflicts.',
    'Inspect host networking and the iproute2 installation manually.',
  ),
  HOST_ROUTE_RANGE_CONFLICT: entry(
    'Planned subnet overlaps a host route',
    'The installer-owned bridge would conflict with existing host routing.',
    'Review the route and network ownership manually. Qiln will not alter routes or implicitly choose another range.',
  ),
  HOST_ADDRESS_INSPECTION_FAILED: entry(
    'Host IPv4 addresses could not be inspected',
    'Qiln cannot establish that the planned gateway and subnet are free of address conflicts.',
    'Inspect host networking and the iproute2 installation manually.',
  ),
  HOST_ADDRESS_RANGE_CONFLICT: entry(
    'Planned subnet overlaps a host address',
    'The bridge gateway and DHCP range must not collide with another host network.',
    'Review and reconfigure the conflicting network manually.',
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
  HOST_ZFS_POOL_MISSING: entry(
    'Required host ZFS pool is unavailable',
    'Qiln does not create, import, format, repair, or reconfigure host ZFS pools.',
    'Have an operator provision or import the required pool manually and verify its health.',
  ),
  HOST_ZFS_POOL_UNHEALTHY: entry(
    'Required host ZFS pool is not healthy',
    'Qiln will not place persistent PostgreSQL data on an unhealthy or incompatible pool.',
    'Inspect zpool status and repair the pool manually.',
  ),
  HOST_ZFS_DATASET_UNAVAILABLE: entry(
    'Required ZFS root dataset is unavailable',
    'The Incus storage pool must be backed by the configured host zpool.',
    'Inspect the host pool and dataset hierarchy manually.',
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
    preservePostgres,
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
    inspectIncus,
    'Reconcile from actual provider state without assuming that partial effects were rolled back.',
  ),
  INCUS_API_UNAVAILABLE: entry(
    'Incus request did not complete reliably',
    'Qiln does not have a complete installation view. A failed response does not establish that a requested mutation had no effect.',
    restoreAccess,
    inspectIncus,
  ),
  INCUS_ACCESS_DENIED: entry(
    'Incus denied the requested operation',
    'Qiln cannot obtain additional authority through privilege escalation.',
    restoreAccess,
  ),
  INCUS_UNEXPECTED_NOT_FOUND: entry(
    'Required Incus resource was not found',
    'This request required a verified resource rather than an optional lookup.',
    inspectIncus,
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
    inspectIncus,
    'Review the installed Qiln CLI version before retrying.',
  ),
  UNSUPPORTED_PLATFORM: entry(
    'Required user identity information is unavailable',
    'Qiln must establish the invoking user identity before using protected installer state or credentials.',
    'Run Qiln on the supported Ubuntu host as an unprivileged developer.',
  ),
  INVALID_LOCAL_CREDENTIAL: entry(
    'Retained credential text is malformed',
    'Retained credentials must contain supported UTF-8 text. Qiln never regenerates over malformed credentials.',
    recoverCredentials,
  ),
  INVALID_NATS_CREDENTIAL: entry(
    'Retained NATS configuration is invalid',
    'The configuration must match the installer-owned schema before its authentication state can be reused.',
    recoverCredentials,
  ),
  INVALID_HOST_CREDENTIAL: entry(
    'Retained Host credential configuration is invalid',
    'The Host credential file must contain exactly the supported fields in the required format.',
    recoverCredentials,
  ),
  INVALID_GATEWAY_HOST_KEY: entry(
    'Retained gateway host key is invalid or encrypted',
    'The gateway requires a persistent unencrypted OpenSSH private key whose public key can be derived.',
    recoverCredentials,
  ),
  INVALID_GATEWAY_HOST_KEY_ALGORITHM: entry(
    'Gateway host key does not use Ed25519',
    'Qiln does not automatically replace or convert retained host keys.',
    recoverCredentials,
  ),
  INVALID_LOCAL_CREDENTIAL_FILE: entry(
    'Retained credential file is unsafe or invalid',
    'Credentials must remain stable bounded regular files with the required ownership and permissions.',
    recoverCredentials,
  ),
  LOCAL_CREDENTIAL_READ_FAILED: entry(
    'Retained credential could not be read safely',
    'Qiln cannot reuse or replace a credential set that cannot be inspected reliably.',
    recoverCredentials,
  ),
  PARTIAL_LOCAL_CREDENTIAL_SET: entry(
    'Local credential set is incomplete',
    'Qiln never fills in, rotates, or regenerates part of a retained credential set.',
    recoverCredentials,
  ),
  LOCAL_CREDENTIAL_TOKEN_MISMATCH: entry(
    'Retained NATS tokens disagree',
    'The NATS and Host files must identify one authoritative authentication value.',
    recoverCredentials,
  ),
  INSTANCE_CREDENTIAL_NAMESPACE_COLLISION: entry(
    'Instance credential namespaces conflict',
    'Text and binary systemd credential namespaces are mutually exclusive for each managed suffix.',
    'Inspect the stopped instance and manually restore the intended credential namespace.',
  ),
  INSTALLATION_STATE_REQUIRED: entry(
    'Installation image pin is unavailable',
    'Credentials may be delivered only to an instance matching the persisted image identity.',
    'Re-run qiln up to reconcile the selected image and installation state.',
  ),
  ORCHESTRATOR_INSTANCE_REQUIRED: entry(
    'Stopped orchestrator is unavailable',
    'Credential delivery requires an exact compatible stopped target instance.',
    'Re-run qiln up to reconcile the development orchestrator.',
  ),
  ORCHESTRATOR_IMAGE_SIGNATURE_MISMATCH: entry(
    'Orchestrator does not match the persisted image',
    'Qiln never delivers credentials to an instance whose base-image signature differs from the installation pin.',
    'Review and remove only the incompatible stopped instance manually, then re-run convergence.',
    preservePostgres,
  ),
  GATEWAY_HOST_KEY_GENERATION_FAILED: entry(
    'Gateway host key could not be generated',
    'The gateway cannot be configured without a retained unencrypted Ed25519 host key.',
    'Inspect the local ssh-keygen installation and retry.',
  ),
  LOCAL_CREDENTIAL_RECOVERY_REQUIRED: entry(
    'Instance credentials exist without their local source',
    'Generating replacements could silently rotate credentials already delivered to the instance.',
    'Recover the original local credential set, or review and manually remove the stopped instance credential state.',
  ),
  LOCAL_CREDENTIAL_PERSISTENCE_FAILED: entry(
    'Generated credential set could not be verified',
    'Qiln delivers credentials only after all four source-of-truth files have been retained and validated.',
    'Inspect the protected installer state directory before retrying.',
  ),
  LOCAL_CREDENTIAL_SET_REQUIRED: entry(
    'Complete local credential set is required',
    'The instance may receive only credentials retained as the local source of truth.',
    'For a new installation, supply a valid authorized-key roster.',
    'For an existing installation, recover the original complete credential set.',
  ),
  FINAL_INSTALLATION_STATE_MISSING: entry(
    'Installation state disappeared during convergence',
    'A successful installation requires one authoritative persisted image identity.',
    'Inspect the protected state directory and any concurrent changes before retrying.',
  ),
  FINAL_LOCAL_CREDENTIAL_SET_MISSING: entry(
    'Local credentials disappeared during convergence',
    'Delivered credentials cannot be verified without their retained local source of truth.',
    recoverCredentials,
  ),
  FINAL_INSTANCE_CREDENTIAL_MISMATCH: entry(
    'Instance credentials do not match local credentials',
    'Qiln reports success only after exact equality with the retained text and binary credentials is verified.',
    'Inspect concurrent instance changes, then re-run qiln up.',
  ),
  FINAL_INSTANCE_STATE_MISMATCH: entry(
    'Instance changed during credential convergence',
    'Credential delivery must preserve unrelated writable instance configuration.',
    'Inspect concurrent configuration changes, then re-run qiln up.',
  ),
  FINAL_IMAGE_ALIAS_MISMATCH: entry(
    'Managed image alias changed during convergence',
    'Split-image convergence requires the alias and persisted image identity to remain consistent.',
    'Inspect concurrent image and alias changes, then re-run qiln up.',
  ),
  AUTHORIZED_KEYS_REQUIRED: entry(
    'First credential set requires an authorized-key roster',
    'Qiln cannot generate its initial complete credential set without an explicitly selected SSH roster.',
    'Supply a valid developer-owned OpenSSH public-key roster with --authorized-keys.',
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
  INVALID_SOURCE_ROOT: entry(
    'Source root cannot be attached to the orchestrator',
    'The source device requires a canonical absolute non-root path without unsupported characters.',
    'Select the canonical Qiln Git checkout root with --source.',
  ),
  INCOMPATIBLE_ORCHESTRATOR_INSTANCE: entry(
    'Existing orchestrator conflicts with the installation',
    'Qiln will not start, stop, rebuild, delete, or partially repair an incompatible retained instance.',
    'Review the differences and remove only the incompatible stopped instance manually if replacement is intended.',
    preservePostgres,
    'Re-run with the intended source checkout and image.',
  ),
  INVALID_INSTALLATION_STATE: entry(
    'Installation state is invalid or incompatible',
    'The state must contain exactly the supported version, project, instance name, and full lowercase image fingerprint.',
    'Review the CLI version and inspect the state file manually before recovery.',
    'Do not discard retained credentials or persistent data.',
  ),
  ORCHESTRATOR_INSTANCE_VERIFICATION_FAILED: entry(
    'Orchestrator is absent after creation',
    'Qiln cannot report success without re-reading the exact stopped instance after its operation completes.',
    'Inspect the instance inventory and operation history before retrying.',
  ),
  INSTALLER_LOCK_CHANGED: entry(
    'Installer lock changed during execution',
    'Qiln will not remove a lock that no longer identifies the protected file it created.',
    'Inspect the state directory manually. Do not remove a lock while an installer process is active.',
  ),
  INSTALLER_LOCKED: entry(
    'Installer lock already exists',
    'Qiln never waits for, removes, or assumes that an existing lock is stale.',
    'Confirm that no qiln up process is active before deciding whether an old lock can be removed manually.',
  ),
  INSTALLER_LOCK_FAILED: entry(
    'Installer lock could not be established',
    'Incus mutations and state writes require a validated exclusive lock. A lock created before validation failed may remain for review.',
    'Inspect state-directory ownership, permissions, and lock state manually.',
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
  INVALID_STATE_HOME: entry(
    'XDG_STATE_HOME must be an absolute path',
    'A relative state path could resolve differently between installer operations.',
    'Unset XDG_STATE_HOME or set it to an absolute developer-owned directory.',
  ),
  MISSING_HOME: entry(
    'Developer has no usable absolute HOME',
    'Qiln cannot determine its default protected installer-state directory.',
    'Use a normal developer login with an absolute HOME directory.',
  ),
  UNSAFE_STATE_ENTRY: entry(
    'Installer state contains an unsafe entry',
    'Symbolic links and special files can redirect state or credential access outside the protected directory.',
    'Inspect the entry manually and restore only an appropriate developer-owned regular file or directory.',
  ),
  INVALID_STATE_OWNER: entry(
    'Installer state belongs to another identity',
    'Qiln must not read or overwrite state owned by a different user.',
    'Inspect the path and correct ownership manually before retrying.',
  ),
  INVALID_STATE_MODE: entry(
    'Installer state permissions are incompatible',
    'Protected state requires the exact file or directory permissions indicated in the diagnostic facts.',
    'Review the path and set the required mode manually.',
  ),
  STATE_ACCESS_FAILED: entry(
    'Installer state could not be inspected safely',
    'Qiln cannot use state that is inaccessible, outside its bounds, or changing during validation.',
    'Inspect the state path and parent permissions, and stop concurrent changes before retrying.',
  ),
  AUTHORIZED_KEYS_NOT_FOUND: entry(
    'Authorized-key roster was not found',
    'A supplied roster must resolve to one stable developer-owned regular file.',
    'Create a normal OpenSSH public-key roster and select it with --authorized-keys.',
  ),
  INVALID_AUTHORIZED_KEYS_OWNER: entry(
    'Authorized-key roster belongs to another identity',
    'The invoking developer must control the public-key roster supplied to the installation.',
    'Copy the intended public keys into a developer-owned regular file.',
  ),
  INVALID_AUTHORIZED_KEYS_FILE: entry(
    'Authorized-key roster could not be read safely',
    'The roster must be a stable bounded regular file without redirected input.',
    'Copy the intended public keys into a normal developer-owned file and select that path.',
  ),
  INVALID_IMAGE_FINGERPRINT: entry(
    'Installation fingerprint is malformed',
    'Qiln persists only full lowercase SHA-256 provider image identities.',
    'Reconcile the selected local image before retrying.',
  ),
  INVALID_AUTHORIZED_KEYS_CONTENT: entry(
    'Authorized-key roster contains unsupported content',
    'The roster accepts normal supported OpenSSH public-key lines and comments, not options, certificates, private keys, malformed blobs, or unsupported control characters.',
    'Export the affected public keys again in normal OpenSSH format with Unix line endings.',
  ),
  EMPTY_AUTHORIZED_KEYS_ROSTER: entry(
    'Authorized-key roster contains no public keys',
    'A supplied roster must contain at least one explicitly selected public key.',
    'Add at least one supported OpenSSH public key.',
  ),
  INVALID_AUTHORIZED_KEYS_ROSTER: entry(
    'OpenSSH could not validate the authorized-key roster',
    'Textual shape alone does not establish valid SSH key structure.',
    'Replace malformed entries with public keys accepted by ssh-keygen.',
  ),
  INCOMPATIBLE_POSTGRES_VOLUME: entry(
    'Existing PostgreSQL volume conflicts with the installation',
    'Qiln never replaces or modifies an incompatible persistent data volume automatically.',
    'Inspect the volume and resolve its naming or configuration conflict manually.',
    preservePostgres,
  ),
  POSTGRES_VOLUME_VERIFICATION_FAILED: entry(
    'PostgreSQL volume is absent after creation',
    'Qiln cannot attach an unverified persistent volume to the orchestrator.',
    'Inspect the storage inventory and daemon logs before retrying.',
  ),
  ROOT_EXECUTION_REFUSED: entry(
    'Qiln refuses to run as root',
    'Public installation commands must use only the unprivileged developer’s existing local authority.',
    'Leave the root shell and run Qiln as the authorized developer.',
    'Perform required host administration separately and manually.',
  ),
  PREFLIGHT_PROCESS_START_FAILED: entry(
    'Required local command could not be started',
    'Qiln cannot establish or generate required state when a supporting command cannot start.',
    'Verify that the command is installed, executable, and accessible to the developer.',
  ),
  PREFLIGHT_PROCESS_TIMEOUT: entry(
    'Required local command exceeded its deadline',
    'Qiln cannot safely continue after an incomplete local operation.',
    'Inspect the command and the host state it requires, then resolve the delay manually.',
  ),
  PREFLIGHT_PROCESS_OUTPUT_LIMIT_EXCEEDED: entry(
    'Required local command exceeded its output limit',
    'Qiln cannot safely retain or interpret an unbounded command response.',
    'Inspect the command and its configuration manually. Qiln will not suppress or retry the response automatically.',
  ),
  INVALID_ARGUMENT: entry(
    'Command-line arguments are invalid',
    'Qiln requires declared options, explicit usable values, and no unexpected positional arguments.',
    'Review qiln --help or qiln up --help and correct the invocation.',
  ),
  IMAGE_FILE_INTERFACE_RETIRED: entry(
    'The --image-file interface has been retired',
    'Split-image imports require explicit metadata and rootfs artifacts so they can be staged, bounded, hashed, and uploaded in order.',
    'Use --image-meta together with --image-rootfs.',
  ),
  SOURCE_REQUIRED: entry(
    'Source checkout is required',
    'The local host monorepo remains the canonical development working copy.',
    'Pass the Qiln Git checkout root with --source.',
  ),
  SPLIT_IMAGE_PAIR_REQUIRED: entry(
    'Both split-image artifacts are required',
    'The image fingerprint and multipart import require the ordered metadata and rootfs pair.',
    'Supply both --image-meta and --image-rootfs, or use --image for an existing local image.',
  ),
  IMAGE_SELECTION_REQUIRED: entry(
    'Select exactly one image input form',
    'One explicit local reference or one explicit split-image replacement must define the installation image pin.',
    'Use --image alone, or supply the paired --image-meta and --image-rootfs options.',
  ),
  DUPLICATE_ARGUMENT: entry(
    'An option was supplied more than once',
    'Qiln does not infer precedence between duplicate installation inputs.',
    'Remove the duplicate option and retry.',
  ),
  INVALID_COLOR_MODE: entry(
    'Color mode is invalid',
    'The supported color modes are auto, always, and never.',
    'Use --color auto, --color always, or --color never.',
  ),
  UNKNOWN_COMMAND: entry(
    'Unknown Qiln command',
    'Qiln fails closed rather than guessing the intended operation.',
    'Review qiln --help and select a declared command.',
  ),
  INTERNAL_ERROR: entry(
    'Unexpected installer failure',
    'Continuing after an unclassified failure could produce an unsafe or misleading installation result. No successful installation should be inferred.',
    'Review the installed CLI version and run qiln doctor.',
    'Inspect actual installation state before retrying a mutation.',
  ),
})
