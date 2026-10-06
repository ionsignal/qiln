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
  COMMAND_CANCELLED: entry('Command canceled', 'No successful completion should be inferred.'),
  INTERACTIVE_TERMINAL_REQUIRED: entry(
    'Interactive terminal is required',
    'Guided authentication and approvals require a real input/output terminal.',
    'Run the command in an unprivileged Linux or macOS terminal, or Windows through WSL. Select the remote flow when the browser is on another machine.',
  ),
  AWS_TOOL_UNAVAILABLE: entry(
    'Managed AWS CLI installation is unavailable for this target',
    'This release provides managed AWS CLI installation only for Linux x64. Compatible external AWS CLI installations remain usable on supported operator platforms.',
    'Use Linux x64 for Qiln-managed installation, or a compatible external AWS CLI on another supported operator platform.',
  ),
  AWS_TOOL_PATH_INVALID: entry(
    'Managed AWS CLI destination is unsupported',
    'Qiln installs into its configured final state location and does not redirect installation to another path.',
    'Review HOME and XDG_STATE_HOME. The managed Linux destination must not contain whitespace or unsupported control characters.',
  ),
  AWS_TOOL_PREREQUISITE_MISSING: entry(
    'Managed AWS CLI installation prerequisite is unavailable',
    'Qiln uses already-installed extraction and platform tools. It does not install prerequisites, execute a package manager, or elevate privileges.',
    'Install or restore the indicated prerequisite manually through an approved procedure.',
  ),
  AWS_TOOL_STATE_INVALID: entry(
    'Managed AWS CLI state is unsafe or incompatible',
    'Tool control directories and records must retain their exact supported schemas, ownership, permissions, and pinned artifact identity.',
    'Inspect protected AWS tool state and the installed Qiln version before retrying.',
    'Do not discard a retained installation or remove a lock while setup may still be active.',
  ),
  AWS_TOOL_PARTIAL: entry(
    'Managed AWS CLI installation requires recovery',
    'A retained target lacks a usable ready record, records an incomplete installation, or still contains its installation workspace. Qiln will not adopt, resume, repair, overwrite, or delete it automatically.',
    'Inspect the installation record, retained payload, workspace, and tool lock.',
    'Confirm that setup is inactive before manually recovering Qiln-owned tool state.',
    'Existing external AWS CLI installations must remain untouched.',
  ),
  AWS_TOOL_PAYLOAD_INVALID: entry(
    'Managed AWS CLI payload failed validation',
    'The payload must have current-user ownership, non-writable group and world permissions, normal files and directories, and only reviewed non-broken links confined to its payload.',
    'Inspect the retained payload and recorded native link policy.',
    'Do not use the executable or silently reinstall over the retained target.',
  ),
  AWS_TOOL_VERSION_INVALID: entry(
    'Managed AWS CLI executable does not match the pin',
    'A verified artifact is not sufficient if its bundled or installed executable cannot establish the exact required CLI version.',
    'Review native runtime compatibility, including Linux glibc requirements, and the retained installation.',
    'Do not replace the pin or adopt another executable to bypass validation.',
  ),
  AWS_TOOL_DOWNLOAD_FAILED: entry(
    'Managed AWS CLI download did not complete',
    'Qiln accepts only bounded HTTPS transfers through the approved host and redirect policy. Network and provider details are not exposed.',
    'Inspect connectivity and any recorded installation state before retrying.',
    'Qiln does not resume downloads or silently overwrite a partial target.',
  ),
  AWS_TOOL_DOWNLOAD_TIMEOUT: entry(
    'Managed AWS CLI download exceeded its deadline',
    'The download was aborted. File handling is completed before confirmed-safe workspace cleanup is attempted.',
    'Inspect the displayed cleanup and recovery outcomes.',
  ),
  AWS_TOOL_VERIFICATION_FAILED: entry(
    'Managed AWS CLI artifact identity did not match',
    'The exact byte count and SHA-256 digest must match the pinned artifact before extraction or execution.',
    'Do not execute or extract the rejected artifact.',
    'Maintainers should review the pinned artifact configuration without weakening runtime verification.',
  ),
  AWS_TOOL_INSTALL_FAILED: entry(
    'Managed AWS CLI installation failed',
    'No successful installation should be inferred. The retained payload is not automatically removed, repaired, or adopted.',
    'Inspect the installation record, workspace, tool lock, and actual platform effects.',
    'Do not assume that installation effects were rolled back.',
  ),
  AWS_TOOL_PROCESS_START_FAILED: entry(
    'Managed AWS CLI setup process could not start',
    'Qiln could not execute a required absolute-path setup command with its sanitized environment.',
    'Inspect the indicated prerequisite or retained installer and its executable permissions.',
  ),
  AWS_TOOL_PROCESS_TIMEOUT: entry(
    'Managed AWS CLI setup exceeded its deadline',
    'Qiln attempted bounded termination of its owned Unix process group. Signal delivery alone does not establish termination.',
    'Use the displayed termination and recovery outcomes before recovering retained inputs.',
  ),
  AWS_TOOL_PROCESS_OUTPUT_LIMIT: entry(
    'Managed AWS CLI setup exceeded its output limit',
    'Qiln does not retain unbounded installer output. It attempts bounded termination without exposing raw process output.',
    'Inspect the retained installation and displayed lifecycle outcomes.',
  ),
  AWS_TOOL_PROCESS_FAILED: entry(
    'Managed AWS CLI setup did not complete cleanly',
    'The setup command failed or left activity in its owned Unix process group. Group handling does not contain descendants that escape that group.',
    'Inspect retained installation state and confirm that setup is inactive before recovery.',
    'For macOS installer failures, also inspect system-mediated installation activity and receipts.',
  ),
  AWS_TOOL_CLEANUP_FAILED: entry(
    'Managed AWS CLI workspace cleanup was not confirmed',
    'Qiln could not confirm input-file closure, workspace removal, or directory synchronization. A ready executable does not excuse incomplete transaction cleanup.',
    'Inspect the retained workspace and displayed lifecycle outcomes.',
    'Do not remove inputs that may still be active.',
  ),
  AWS_TOOL_LOCKED: entry(
    'Managed AWS CLI tools are locked',
    'Tool installation uses a separate shared lock. Qiln does not wait for it or assume it is stale, including when a ready record is already present.',
    'Confirm that no setup process or system-mediated installation remains active before manually recovering the lock.',
  ),
  AWS_TOOL_LOCK_CHANGED: entry(
    'Managed AWS CLI tool lock changed',
    'Qiln will not unlink a lock that no longer identifies the protected file it created.',
    'Inspect protected tool state and concurrent processes manually.',
  ),
  AWS_TOOL_LOCK_FAILED: entry(
    'Managed AWS CLI tool lock handling failed',
    'Exclusive tool locking or confirmed lock release did not complete. A lock created before validation failed may remain.',
    'Inspect the tool lock, directory permissions, installation record, and actual setup activity.',
  ),
  AWS_TOOL_RECOVERY_REQUIRED: entry(
    'Managed AWS CLI recovery remains outstanding',
    'The original failure is preserved, but process termination, workspace cleanup, failure-record persistence, or tool-lock release was not confirmed. A ready record may already exist; no authentication or automatic rollback should be inferred.',
    'Use the displayed outcomes to identify outstanding work.',
    'Retain potentially active installer inputs and the protective lock until activity has been checked.',
    'Confirm that no installer process or escaping descendant remains active before removing retained inputs.',
    'Recover only the selected Qiln-owned tool state. Do not alter external AWS CLI installations or connection authentication state.',
  ),
  AWS_PLATFORM_UNSUPPORTED: entry(
    'AWS operator platform is unsupported',
    'AWS commands require Linux or macOS with Unix ownership and permission checks. They do not require the development installer’s Ubuntu, Incus, or ZFS setup.',
    'Run Qiln as an unprivileged Linux or macOS operator. On Windows, use WSL with state stored on its Linux filesystem.',
  ),
  AWS_CLI_MISSING: entry(
    'AWS CLI is unavailable',
    'No compatible external AWS CLI was found. Qiln-managed installation is available on Linux x64 and requires explicit approval.',
    'On Linux x64, approve managed installation through qiln aws connect. Other supported operator platforms require a compatible external AWS CLI.',
  ),
  AWS_CLI_UNSUPPORTED: entry(
    'AWS CLI version is outside the reviewed baseline',
    'This release accepts only its pinned reference version. An incompatible external installation is not modified; selection can continue to a validated managed CLI or an available installation proposal.',
    'Use the pinned reference version or approve an available managed installation through qiln aws connect. Qiln will not update the external installation.',
  ),
  AWS_CLI_CHECK_FAILED: entry(
    'AWS CLI compatibility check did not complete',
    'Qiln could not establish the installed CLI version through a bounded non-interactive command.',
    'Inspect the executable, its accessibility, and the reported failure category.',
  ),
  AWS_LOGIN_FAILED: entry(
    'AWS browser authentication did not complete',
    'Qiln does not infer successful authentication from an unsuccessful or interrupted AWS CLI process.',
    'Review the AWS CLI terminal output and complete a fresh login.',
  ),
  AWS_LOGIN_TIMEOUT: entry(
    'AWS login exceeded its local deadline',
    'Bounded termination of the interactive authentication process was attempted. Its local authentication context is not accepted as a completed connection; use the displayed termination and recovery outcomes.',
    'Complete a fresh login when ready to finish the browser flow.',
  ),
  AWS_ROOT_REQUIRED: entry(
    'Root bootstrap requires the intended AWS root identity',
    'Only the separate approved bootstrap context may use root authentication. Ordinary operator connections continue rejecting root.',
    'Sign in as the intended account root user through the bootstrap browser flow.',
  ),
  AWS_ROOT_MFA_REQUIRED: entry(
    'Root MFA is not configured',
    'IAM mutations require observed root MFA configuration. This observation does not prove that this particular session authenticated with MFA.',
    'Enroll root MFA in the AWS browser, then recheck before approving IAM changes.',
  ),
  AWS_BOOTSTRAP_STATE_INVALID: entry(
    'AWS bootstrap state is unsafe or incompatible',
    'The separate bootstrap journal and root authentication subtree must match their protected schemas, ownership, operation identity, and expected phase.',
    'Inspect the bootstrap journal, authentication subtree, and connection lock.',
    'Do not adopt resources or replay recorded mutations automatically.',
  ),
  AWS_BOOTSTRAP_CONFLICT: entry(
    'State conflicts with the approved bootstrap',
    'The local connection entry is not suitable for new-account setup, the selected IAM user already exists, or its permissions, credentials, or login state differ from the approved setup.',
    'Use the existing-operator flow for an existing local connection. Inspect any recorded bootstrap and actual IAM user manually.',
    'Qiln will not adopt the user, overwrite unexpected permissions, issue another password, or delete IAM resources.',
  ),
  AWS_BOOTSTRAP_OWNERSHIP_INVALID: entry(
    'IAM operator ownership could not be verified',
    'Subsequent bootstrap operations require the approved account, Qiln IAM path, exact ownership tags, operator ARN, and recorded immutable user ID.',
    'Stop concurrent IAM changes and inspect the user and bootstrap journal manually.',
    'Do not infer ownership from a matching user name alone.',
  ),
  AWS_BOOTSTRAP_POLICY_CHANGED: entry(
    'Bootstrap policy differs from the reviewed permissions',
    'The current managed policy or supplied approval differs from the restricted reviewed document. AWS-managed policy attachments cannot permanently pin an AWS-controlled version.',
    'Review the managed policy default document and the retained bootstrap operation.',
    'Do not bypass the review or grant broader permissions to complete setup.',
  ),
  AWS_BOOTSTRAP_INSPECTION_FAILED: entry(
    'Required IAM bootstrap inspection did not complete',
    'Qiln could not establish the required bounded account, policy, user, password-policy, or credential state.',
    'Inspect AWS availability and the actual IAM state before recovery.',
    'A failed read-after-write does not establish that the mutation had no effect.',
  ),
  AWS_BOOTSTRAP_VERIFICATION_FAILED: entry(
    'IAM mutation outcome was not verified',
    'A narrowly scoped read-verification budget ended before the expected artifact became visible. The recorded mutation may have completed; Qiln did not repeat it.',
    'Inspect the bootstrap journal and actual IAM user, ownership tags, policy attachments, inline policy, or login profile for the recorded phase.',
    'Do not interpret the exhausted budget as failed creation or automatically replay the mutation.',
    'If the password phase is recorded, do not attempt password recovery or reissuance through Qiln.',
  ),
  AWS_BOOTSTRAP_READINESS_UNKNOWN: entry(
    'Operator password-reset readiness is unknown',
    'The login-profile response did not provide an explicit boolean password-reset state. Qiln does not interpret omission as false or continue prompting indefinitely.',
    'Inspect the operator login profile and the pinned CLI/SDK behavior after browser password replacement.',
    'Record an operator-run walkthrough and review the smallest evidence-based correction before changing readiness semantics.',
    'No completed onboarding or IAM rollback should be inferred.',
  ),
  AWS_BOOTSTRAP_PASSWORD_REJECTED: entry(
    'AWS rejected the initial operator password',
    'The password was generated in the isolated bootstrap process, but AWS remains the final account-password-policy validator. No password retry or reissuance is performed.',
    'Inspect the account password policy and recorded IAM operation manually.',
    'Preserve any partially created operator rather than silently replacing its credentials.',
  ),
  AWS_BOOTSTRAP_PASSWORD_UNAVAILABLE: entry(
    'Initial operator password delivery was not confirmed',
    'The login profile may already exist, but the successful creation response or terminal delivery was not verified. Qiln does not retain the password or attempt to display or issue it again.',
    'Inspect the bootstrap journal and operator login profile manually.',
    'Use an explicitly reviewed administrator recovery procedure; do not rerun password creation through Qiln.',
  ),
  AWS_BOOTSTRAP_RECORDED: entry(
    'A bootstrap operation is already recorded',
    'Ordinary connection use requires a fully completed bootstrap journal bound to the saved operator. Incomplete or failed bootstrap is not automatically resumed, adopted, repaired, or overwritten.',
    'Inspect the protected bootstrap journal and actual IAM resources.',
    'Preserve recorded ownership and resource identities during manual recovery.',
    'Explicit local disconnect may remove validated records only after authentication termination is confirmed and retained IAM resources are disclosed. It never deletes IAM resources.',
  ),
  AWS_BOOTSTRAP_RECOVERY_REQUIRED: entry(
    'AWS bootstrap recovery remains outstanding',
    'Authentication termination, root-context cleanup, or failure-journal persistence was not confirmed. IAM mutations may already have completed, and no automatic rollback is attempted.',
    'Use the displayed lifecycle and journal outcomes to identify outstanding recovery.',
    'Retain potentially active authentication inputs and the protective connection lock until authentication activity has been checked.',
    'Inspect IAM resources against the recorded account, operation ID, ownership tags, and immutable user ID.',
    'Do not automatically delete resources, adopt an existing user, or reissue its initial password.',
  ),
  AWS_CONNECTION_NAME_INVALID: entry(
    'AWS connection name is invalid',
    'Names must be 1–48 lowercase ASCII letters, digits, underscores, or hyphens, beginning with a letter or digit.',
    'Choose a normal connection name without path separators or whitespace.',
  ),
  AWS_CONNECTION_NAME_REQUIRED: entry(
    'AWS connection name is required',
    'This operation must identify one local connection explicitly.',
    'Supply --name with the intended connection name.',
  ),
  AWS_REGION_INVALID: entry(
    'AWS region is unsupported or malformed',
    'This batch accepts ordinary commercial AWS region names. Non-commercial partitions are not supported.',
    'Enter a commercial region such as us-east-1.',
  ),
  AWS_CONNECTION_NOT_FOUND: entry(
    'Local AWS connection was not found',
    'Qiln found no selected connection in its protected local state.',
    'Run qiln aws connect to create a CLI-owned connection.',
  ),
  AWS_CONNECTION_INCOMPLETE: entry(
    'AWS connection setup is incomplete',
    'An operation or local directory exists without a completed connection record.',
    'Resume with qiln aws connect using the same name, or explicitly disconnect the local entry.',
  ),
  AWS_DISCONNECT_INCOMPLETE: entry(
    'Local AWS disconnect is incomplete',
    'The journal records approved local removal. Qiln will not reinterpret it as a connection attempt.',
    'Re-run disconnect for the same connection after inspecting local state.',
  ),
  AWS_STATE_INVALID: entry(
    'AWS connection state is unsafe or incompatible',
    'Connection records and authentication directories must retain supported schemas, ownership, permissions, and bounded regular files.',
    'Inspect the protected AWS state directory and stop concurrent changes.',
    'Do not discard recorded identities or remove locks while another Qiln process is active.',
  ),
  AWS_LOCKED: entry(
    'AWS connection state is locked',
    'Qiln does not wait for an existing lock or assume it is stale.',
    'Confirm that no AWS connection command or authentication subprocess is active before manually recovering a leftover lock.',
  ),
  AWS_LOCK_CHANGED: entry(
    'AWS connection lock changed',
    'Qiln will not unlink a lock that no longer identifies the protected file it created.',
    'Inspect the AWS state directory and concurrent processes manually.',
  ),
  AWS_LOCK_FAILED: entry(
    'AWS connection lock could not be established',
    'Authentication-state changes require a validated exclusive lock. A lock created before validation failed may remain.',
    'Inspect directory ownership, permissions, and lock state before retrying.',
  ),
  AWS_PROFILE_INVALID: entry(
    'Qiln-owned AWS authentication profile is invalid',
    'Only the dedicated login profile, empty shared-credentials file, and protected login cache are accepted. Other credential styles cannot take precedence.',
    'Inspect the Qiln-owned authentication files. Reconnect to replace only this connection’s local authentication context.',
  ),
  AWS_SSO_UNSUPPORTED: entry(
    'AWS SSO profiles are not supported',
    'Qiln detects SSO configuration before resolving credentials. This release supports direct IAM-user browser login only.',
    'Use an existing IAM-user operator connection. SSO onboarding is deferred.',
  ),
  AWS_ROOT_REFUSED: entry(
    'Root AWS authentication is refused',
    'Normal connections must resolve to a non-root IAM user. Root authority is accepted only in the separate explicitly approved bootstrap context.',
    'Select the intended IAM operator in the browser and complete a fresh login.',
  ),
  AWS_PRINCIPAL_UNSUPPORTED: entry(
    'AWS principal type is unsupported',
    'This release requires a direct IAM-user identity in a commercial AWS account, not an assumed role, federated session, or another partition.',
    'Authenticate as the intended IAM operator.',
  ),
  AWS_IDENTITY_INVALID: entry(
    'AWS returned an incompatible identity',
    'Qiln could not establish a supported account, operator ARN, and immutable user identity.',
    'Inspect the selected browser account and complete a fresh login.',
  ),
  AWS_IDENTITY_MISMATCH: entry(
    'Authenticated operator differs from the recorded identity',
    'Connection reuse requires the same account ID, user ARN, and immutable user ID. Matching a profile or user name is insufficient.',
    'Authenticate as the recorded operator, or choose a new connection name for another identity.',
  ),
  AWS_AUTH_FAILED: entry(
    'AWS authentication could not be verified',
    'The dedicated login credentials or cache were unavailable or rejected. An interrupted refresh may leave an unusable cache; Qiln does not fall back to ambient keys, roles, or other profiles.',
    'Reconnect using the same connection name and complete a fresh browser login.',
  ),
  AWS_AUTH_EXPIRED: entry(
    'AWS authentication has expired',
    'The recorded identity is not a substitute for usable temporary credentials.',
    'Reconnect and complete a fresh browser login.',
  ),
  AWS_ACCESS_DENIED: entry(
    'AWS denied the requested operation',
    'Browser login, credential refresh, bootstrap IAM actions, and infrastructure deployment have separate permission boundaries. No successful mutation or automatic rollback should be inferred.',
    'Review the selected identity and required permissions with the account owner. Inspect any recorded bootstrap phase before recovery.',
  ),
  AWS_REQUEST_FAILED: entry(
    'AWS request did not complete reliably',
    'A failed or incomplete request does not establish a verified connection or a failed IAM mutation. A recorded mutation may already have completed, and Qiln does not replay it automatically.',
    'Inspect network access, AWS availability, and any recorded operation against actual IAM state.',
    'For a password-creation intent, use an explicitly reviewed administrator recovery procedure rather than recovering or reissuing the password through Qiln.',
  ),
  AWS_CONTEXT_FAILED: entry(
    'Isolated AWS credential process failed',
    'Qiln accepts only a validated response after its private credential process has exited. Raw provider output is not exposed.',
    'Build the CLI and inspect its installation before retrying.',
  ),
  AWS_CONTEXT_TIMEOUT: entry(
    'AWS credential verification exceeded its deadline',
    'Bounded termination of the isolated credential process was attempted. Use the displayed termination and recovery outcomes; no successful authentication is inferred.',
    'Inspect connectivity and retry authentication.',
  ),
  AWS_CLEANUP_FAILED: entry(
    'Local AWS authentication cleanup failed',
    'Qiln could not confirm safe removal and directory synchronization of its owned authentication state.',
    'Inspect the protected connection directory, connection and operation records, and any remaining authentication state before manual recovery.',
    'Local removal is not immediate revocation of credentials loaded elsewhere.',
  ),
  AWS_RECOVERY_REQUIRED: entry(
    'AWS authentication recovery is incomplete',
    'The original operation failed, and authentication termination, cleanup, failure-journal persistence, or connection-lock release was not confirmed. The displayed outcomes are authoritative; a connection record may already have been saved, and no rollback should be inferred.',
    'If authentication termination is unconfirmed, retain its inputs and the protective connection lock until activity has been checked.',
    'If authentication cleanup is not confirmed, verify that no Qiln authentication subprocess is active, then inspect and recover the remaining Qiln-owned authentication state.',
    'If failure-journal persistence is not confirmed, inspect the connection and operation records before reconnecting or disconnecting.',
    'Use the same connection name when reconnecting so the recorded account, operator ARN, and immutable user ID remain enforced.',
    'Local removal is not immediate revocation of credentials loaded elsewhere.',
  ),
})
