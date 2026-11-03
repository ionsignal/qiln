import { entry } from '../define'

export const awsGuestDiagnostics = Object.freeze({
  AWS_DEPLOYMENT_VERIFY_FAILED: entry(
    'Guest baseline was not verified',
    'Fixed read-only probes over the pinned SSH connection left at least one required check unpassed; only a passed check establishes anything, an interrupted probe may have completed, and nothing was installed, written, or replayed.',
    'Review each displayed check result and its detail.',
    'If cloud-init did not finish within its wait or the connection ended, run verify again. A rerun repeats every probe.',
    'Qiln does not repair the guest. If a check keeps failing, inspect the instance outside Qiln.',
  ),
  AWS_DEPLOYMENT_SSH_UNAVAILABLE: entry(
    'Interactive administrative SSH is not available yet',
    'This command is reserved for an interactive administrative session that is not implemented, so it opened no protected state, lock, private key, AWS call, or SSH connection.',
    'To check only the basic guest baseline, run qiln aws deployment verify. That is a read-only check, not an administrative session.',
  ),
})
