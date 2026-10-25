import { entry } from '../define'

export const awsGuestDiagnostics = Object.freeze({
  AWS_DEPLOYMENT_VERIFY_FAILED: entry(
    'Guest baseline was not verified',
    'Qiln ran fixed read-only probes over the pinned, key-authenticated SSH connection, and at least one required check did not pass. A check can fail, produce output Qiln cannot interpret, be interrupted, or not run because the connection ended. Only a passed check establishes anything, and an interrupted probe may have completed on the guest. Nothing was installed, written, replayed, or retained, and the architecture is observed but never compared.',
    'Review each displayed check result and its detail.',
    'If cloud-init did not finish within its wait or the connection ended, run verify again. A rerun repeats every probe.',
    'Qiln does not repair the guest. If a check keeps failing, inspect the instance outside Qiln.',
  ),
  AWS_DEPLOYMENT_SSH_UNAVAILABLE: entry(
    'Interactive administrative SSH is not available yet',
    'This command is reserved for an interactive administrative session to the recorded deployment, using its validated administrative key and pinned server host key. That session is not implemented, so nothing was opened or changed: no protected state, lock, private key, AWS call, or SSH connection was used. The command does not run a login check, request a terminal, or accept a remote command.',
    'To check only the basic guest baseline, run qiln aws deployment verify. That is a read-only check, not an administrative session.',
  ),
})
