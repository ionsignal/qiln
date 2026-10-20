import { entry } from './define'

export const sshDiagnostics = Object.freeze({
  SSH_CONNECTION_FAILED: entry(
    'SSH connection could not be established',
    'The network connection, key exchange, or handshake did not complete within its deadline, so no command was run. Qiln does not retry, look for another endpoint, or accept an unpinned host key. SSH is reachable only from the administrator network approved with the deployment, so a changed public address of the administrator can be a cause.',
    'Confirm that the administrator network approved with the deployment still contains your current public address.',
    'Confirm that the instance is running and that the recorded Elastic IP is still associated with it.',
  ),
  SSH_HOST_KEY_MISMATCH: entry(
    'SSH server identity does not match the pinned host key',
    'Qiln accepts only an Ed25519 host key whose fingerprint equals the retained evidence. The connection ended during the handshake, before any authentication, so no credential was sent and no command was run. The pin is never replaced automatically.',
    'Compare the displayed pinned and observed fingerprints.',
    'Treat the endpoint as unverified until the difference is explained, for example by an address that was reassigned or host keys that were regenerated on the guest.',
  ),
  SSH_AUTHENTICATION_FAILED: entry(
    'The server did not accept the administrative key',
    'The server presented the pinned host key, but public-key authentication with the deployment’s administrative key was not accepted. No command was run, and no other authentication method is attempted.',
    'Check that the cloud-init bootstrap created the administrator account and received the AWS key pair public key.',
    'Do not replace the administrative key or the retained evidence to bypass this state.',
  ),
  SSH_COMMAND_FAILED: entry(
    'Remote SSH command did not complete reliably',
    'Qiln requires an explicit exit status within the command deadline and the output limit. Closing the connection does not prove that the remote command stopped, so its effects are uncertain. Qiln never replays a command automatically.',
    'Inspect the host before running anything again, because the command may have started or completed.',
  ),
  SSH_TRANSFER_FAILED: entry(
    'SFTP file transfer did not complete reliably',
    'Qiln requires the approved number of bytes to be sent, and the remote file to be created exclusively and closed successfully, within one deadline. Closing the connection does not prove that the remote file was not created or fully written, so a partial remote file may remain. Qiln never retries, resumes, replaces, or deletes remote files automatically.',
    'Inspect the remote location before running anything again. Any file found there is evidence, not a verified upload.',
    'Files are created exclusively, so a new attempt must use a new remote path.',
  ),
})
