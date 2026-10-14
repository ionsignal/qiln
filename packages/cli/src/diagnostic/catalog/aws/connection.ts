import { entry } from '../define'

export const awsConnectionDiagnostics = Object.freeze({
  AWS_PLATFORM_UNSUPPORTED: entry(
    'AWS operator platform is unsupported',
    'AWS commands require Linux or macOS with Unix ownership and permission checks. They do not require the development installer’s Ubuntu, Incus, or ZFS setup.',
    'Run Qiln as an unprivileged Linux or macOS operator. On Windows, use WSL with state stored on its Linux filesystem.',
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
  AWS_CONNECTION_NAME_INVALID: entry(
    'AWS connection name is invalid',
    'Names must be 1–48 lowercase ASCII letters, digits, underscores, or hyphens, beginning with a letter or digit.',
    'Choose a normal connection name without path separators or whitespace.',
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
    'AWS operation state is locked',
    'Qiln does not wait for an existing lock or assume it is stale.',
    'Confirm that no AWS command or authentication subprocess is active before manually recovering a leftover lock.',
  ),
  AWS_LOCK_CHANGED: entry(
    'AWS operation lock changed',
    'Qiln will not unlink a lock that no longer identifies the protected file it created.',
    'Inspect the AWS state directory and concurrent processes manually.',
  ),
  AWS_LOCK_FAILED: entry(
    'AWS operation lock could not be established',
    'AWS operations require a validated exclusive lock. A lock created before validation failed may remain.',
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
    'The requested connection session login credentials or cache were unavailable or rejected by aws.',
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
