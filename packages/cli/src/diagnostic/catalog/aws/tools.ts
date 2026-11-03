import { entry } from '../define'

export const awsToolDiagnostics = Object.freeze({
  AWS_TOOL_UNAVAILABLE: entry(
    'Managed AWS CLI installation is unavailable for this target',
    'This release provides managed AWS CLI installation only for Linux x64 and macOS (Intel and Apple Silicon), while compatible external AWS CLI installations remain usable on supported operator platforms.',
    'Use Linux x64 or macOS for Qiln-managed installation, or a compatible external AWS CLI on another supported operator platform.',
  ),
  AWS_TOOL_PATH_INVALID: entry(
    'Managed AWS CLI destination is unsupported',
    'Qiln installs into its configured final state location and does not redirect installation to another path.',
    'Review HOME and XDG_STATE_HOME. The managed destination must not contain whitespace or unsupported control characters.',
  ),
  AWS_TOOL_PREREQUISITE_MISSING: entry(
    'Managed AWS CLI installation prerequisite is unavailable',
    'Qiln uses already-installed extraction and platform tools and never installs prerequisites, executes a package manager, or elevates privileges.',
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
    'A retained target lacks a usable ready record, records an incomplete installation, or still contains its installation workspace, and Qiln will not adopt, resume, repair, overwrite, or delete it automatically.',
    'Inspect the installation record, retained payload, workspace, and tool lock.',
    'Confirm that setup is inactive before manually recovering Qiln-owned tool state.',
    'Existing external AWS CLI installations must remain untouched.',
  ),
  AWS_TOOL_PAYLOAD_INVALID: entry(
    'Managed AWS CLI payload failed validation',
    'The payload must have current-user ownership, non-writable group and world permissions, normal files and directories, and only reviewed non-broken links confined to it.',
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
    'Qiln accepts only bounded HTTPS transfers through the approved host and redirect policy and exposes no network or provider details.',
    'Inspect connectivity and any recorded installation state before retrying.',
    'Qiln does not resume downloads or silently overwrite a partial target.',
  ),
  AWS_TOOL_DOWNLOAD_TIMEOUT: entry(
    'Managed AWS CLI download exceeded its deadline',
    'The download was aborted, and file handling is completed before confirmed-safe workspace cleanup is attempted.',
    'Inspect the displayed cleanup and recovery outcomes.',
  ),
  AWS_TOOL_VERIFICATION_FAILED: entry(
    'Managed AWS CLI artifact identity did not match',
    'The exact byte count and SHA-256 digest must match the pinned artifact before extraction or execution, and on macOS the package signer and notarization must also match the pinned release.',
    'Do not execute or extract the rejected artifact.',
    'Maintainers should review the pinned artifact configuration without weakening runtime verification.',
  ),
  AWS_TOOL_INSTALL_FAILED: entry(
    'Managed AWS CLI installation failed',
    'No successful installation should be inferred, and the retained payload is not automatically removed, repaired, or adopted.',
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
    'Qiln attempted bounded termination of its owned Unix process group, and signal delivery alone does not establish termination.',
    'Use the displayed termination and recovery outcomes before recovering retained inputs.',
  ),
  AWS_TOOL_PROCESS_OUTPUT_LIMIT: entry(
    'Managed AWS CLI setup exceeded its output limit',
    'Qiln does not retain unbounded installer output, so it attempts bounded termination without exposing raw process output.',
    'Inspect the retained installation and displayed lifecycle outcomes.',
  ),
  AWS_TOOL_PROCESS_FAILED: entry(
    'Managed AWS CLI setup did not complete cleanly',
    'The setup command failed or left activity in its owned Unix process group, which does not contain descendants that escape that group.',
    'Inspect retained installation state and confirm that setup is inactive before recovery.',
    'For macOS installer failures, also inspect system-mediated installation activity and receipts.',
  ),
  AWS_TOOL_CLEANUP_FAILED: entry(
    'Managed AWS CLI workspace cleanup was not confirmed',
    'Qiln could not confirm input-file closure, workspace removal, or directory synchronization, and a ready executable does not excuse incomplete transaction cleanup.',
    'Inspect the retained workspace and displayed lifecycle outcomes.',
    'Do not remove inputs that may still be active.',
  ),
  AWS_TOOL_LOCKED: entry(
    'Managed AWS CLI tools are locked',
    'Tool installation uses a separate shared lock that Qiln does not wait for or assume is stale, even when a ready record is present.',
    'Confirm that no setup process or system-mediated installation remains active before manually recovering the lock.',
  ),
  AWS_TOOL_LOCK_CHANGED: entry(
    'Managed AWS CLI tool lock changed',
    'Qiln will not unlink a lock that no longer identifies the protected file it created.',
    'Inspect protected tool state and concurrent processes manually.',
  ),
  AWS_TOOL_LOCK_FAILED: entry(
    'Managed AWS CLI tool lock handling failed',
    'Exclusive tool locking or confirmed lock release did not complete, and a lock created before validation failed may remain.',
    'Inspect the tool lock, directory permissions, installation record, and actual setup activity.',
  ),
  AWS_TOOL_RECOVERY_REQUIRED: entry(
    'Managed AWS CLI recovery remains outstanding',
    'The original failure is preserved, but process termination, workspace cleanup, failure-record persistence, or tool-lock release was not confirmed, so a ready record may already exist and no authentication or rollback should be inferred.',
    'Use the displayed outcomes to identify outstanding work.',
    'Retain potentially active installer inputs and the protective lock until activity has been checked.',
    'Confirm that no installer process or escaping descendant remains active before removing retained inputs.',
    'Recover only the selected Qiln-owned tool state. Do not alter external AWS CLI installations or connection authentication state.',
  ),
  AWS_CLI_MISSING: entry(
    'AWS CLI is unavailable',
    'No compatible external AWS CLI was found, and Qiln-managed installation is available on Linux x64 and macOS with explicit approval.',
    'On Linux x64 or macOS, approve managed installation through qiln aws connect. Other supported operator platforms require a compatible external AWS CLI.',
  ),
  AWS_CLI_UNSUPPORTED: entry(
    'AWS CLI version is outside the reviewed baseline',
    'This release accepts only its pinned reference version, and an incompatible external installation is never modified while selection can continue to a validated managed CLI or an available installation proposal.',
    'Use the pinned reference version or approve an available managed installation through qiln aws connect. Qiln will not update the external installation.',
  ),
  AWS_CLI_CHECK_FAILED: entry(
    'AWS CLI compatibility check did not complete',
    'Qiln could not establish the installed CLI version through a bounded non-interactive command.',
    'Inspect the executable, its accessibility, and the reported failure category.',
  ),
})
