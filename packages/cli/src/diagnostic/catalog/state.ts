import { entry } from './define'

const recoverCredentialsStep =
  'Inspect and recover the complete four-file local credential set before retrying. Do not regenerate individual credentials.'

export const stateDiagnostics = Object.freeze({
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
  INSTALLER_LOCK_CHANGED: entry(
    'Installer lock changed during execution',
    'Qiln will not remove a lock that no longer identifies the protected file it created.',
    'Inspect the state directory manually. Do not remove a lock while an installer process is active.',
  ),
  INSTALLER_LOCKED: entry(
    'Installer lock already exists',
    'Qiln never waits for, removes, or assumes that an existing lock is stale.',
    'Confirm that no qiln installation process is active before deciding whether an old lock can be removed manually.',
  ),
  INSTALLER_LOCK_FAILED: entry(
    'Installer lock could not be established',
    'Incus mutations and state writes require a validated exclusive lock. A lock created before validation failed may remain for review.',
    'Inspect state-directory ownership, permissions, and lock state manually.',
  ),
  INVALID_LOCAL_CREDENTIAL: entry(
    'Retained credential text is malformed',
    'Retained credentials must contain supported UTF-8 text. Qiln never regenerates over malformed credentials.',
    recoverCredentialsStep,
  ),
  INVALID_NATS_CREDENTIAL: entry(
    'Retained NATS configuration is invalid',
    'The configuration must match the installer-owned schema before its authentication state can be reused.',
    recoverCredentialsStep,
  ),
  INVALID_HOST_CREDENTIAL: entry(
    'Retained Host credential configuration is invalid',
    'The Host credential file must contain exactly the supported fields in the required format.',
    recoverCredentialsStep,
  ),
  INVALID_GATEWAY_HOST_KEY: entry(
    'Retained gateway host key is invalid or encrypted',
    'The gateway requires a persistent unencrypted OpenSSH private key whose public key can be derived.',
    recoverCredentialsStep,
  ),
  INVALID_GATEWAY_HOST_KEY_ALGORITHM: entry(
    'Gateway host key does not use Ed25519',
    'Qiln does not automatically replace or convert retained host keys.',
    recoverCredentialsStep,
  ),
  INVALID_LOCAL_CREDENTIAL_FILE: entry(
    'Retained credential file is unsafe or invalid',
    'Credentials must remain stable bounded regular files with the required ownership and permissions.',
    recoverCredentialsStep,
  ),
  LOCAL_CREDENTIAL_READ_FAILED: entry(
    'Retained credential could not be read safely',
    'Qiln cannot reuse or replace a credential set that cannot be inspected reliably.',
    recoverCredentialsStep,
  ),
  PARTIAL_LOCAL_CREDENTIAL_SET: entry(
    'Local credential set is incomplete',
    'Qiln never fills in, rotates, or regenerates part of a retained credential set.',
    recoverCredentialsStep,
  ),
  LOCAL_CREDENTIAL_TOKEN_MISMATCH: entry(
    'Retained NATS tokens disagree',
    'The NATS and Host files must identify one authoritative authentication value.',
    recoverCredentialsStep,
  ),
  INSTANCE_CREDENTIAL_NAMESPACE_COLLISION: entry(
    'Instance credential namespaces conflict',
    'Text and binary systemd credential namespaces are mutually exclusive for each managed suffix.',
    'Inspect the stopped instance and manually restore the intended credential namespace.',
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
  FINAL_LOCAL_CREDENTIAL_SET_MISSING: entry(
    'Local credentials disappeared during convergence',
    'Delivered credentials cannot be verified without their retained local source of truth.',
    recoverCredentialsStep,
  ),
  FINAL_INSTANCE_CREDENTIAL_MISMATCH: entry(
    'Instance credentials do not match local credentials',
    'Qiln reports success only after exact equality with the retained text and binary credentials is verified.',
    'Inspect concurrent instance changes, then re-run qiln installation configure for the same target.',
  ),
  AUTHORIZED_KEYS_REQUIRED: entry(
    'First credential set requires an authorized-key roster',
    'Qiln cannot generate its initial complete credential set without an explicitly selected SSH roster.',
    'Supply a valid developer-owned OpenSSH public-key roster with --authorized-keys.',
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
})
