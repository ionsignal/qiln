import { entry } from './define'

export const sshDiagnostics = Object.freeze({
  SSH_CONNECTION_FAILED: entry(
    'SSH connection could not be established',
    'The network connection, key exchange, or handshake did not complete within its deadline, so no command was run, and Qiln neither retries, looks for another endpoint, nor accepts an unpinned host key.',
    'Confirm that the administrator network approved with the deployment still contains your current public address.',
    'Confirm that the instance is running and that the recorded Elastic IP is still associated with it.',
  ),
  SSH_HOST_KEY_MISMATCH: entry(
    'SSH server identity does not match the pinned host key',
    'The server did not present an Ed25519 host key matching the retained pin, so the handshake ended before any authentication and the pin was not replaced.',
    'Compare the displayed pinned and observed fingerprints.',
    'Treat the endpoint as unverified until the difference is explained, for example by an address that was reassigned or host keys that were regenerated on the guest.',
  ),
  SSH_AUTHENTICATION_FAILED: entry(
    'The server did not accept the administrative key',
    'The server presented the pinned host key but did not accept public-key authentication with the deployment’s administrative key, so no command was run and no other method was tried.',
    'Check that the cloud-init bootstrap created the administrator account and received the AWS key pair public key.',
    'Do not replace the administrative key or the retained evidence to bypass this state.',
  ),
  SSH_COMMAND_FAILED: entry(
    'Remote SSH command did not complete reliably',
    'Qiln requires an explicit exit status within the command deadline and output limit, and closing the connection does not prove that the remote command stopped, so its effects are uncertain and it is never replayed.',
    'Inspect the host before running anything again, because the command may have started or completed.',
  ),
  SSH_SOCKET_FAILED: entry(
    'Incus socket channel could not be opened over SSH',
    'The authenticated SSH connection did not get a channel to the Incus Unix socket, which is root-equivalent authority, so no Incus request was sent; forwarding may be disabled or the account may lack permission, and Qiln neither falls back to another transport nor changes SSH or socket configuration.',
    'Run qiln aws deployment prepare so the approved preparation can grant the administrator account Incus socket access.',
    'A group change applies only to new SSH connections, so run the command again afterwards.',
    'If forwarding is disabled, inspect the effective sshd configuration; Qiln does not edit it.',
  ),
})
