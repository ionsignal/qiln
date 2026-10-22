import { entry } from '../define'

export const awsDeliveryDiagnostics = Object.freeze({
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
  AWS_DEPLOYMENT_DELIVERY_FAILED: entry(
    'Source delivery did not complete',
    'Qiln delivers the approved source archive in fixed stages over the pinned, key-authenticated connection: a guest tool check, a fresh destination, an exclusive upload, a remote SHA-256 comparison, and extraction. The displayed stage did not complete. A remote operation that was interrupted may already have completed, so remote effects are uncertain unless the stage reports a refusal. Nothing is retried, resumed, replaced, or deleted, and anything under the attempt path remains as evidence. A matching digest establishes byte identity, not safe archive structure, and delivery never installs, builds, starts, or activates anything.',
    'Inspect the displayed attempt path on the guest before running anything again. Anything found there is evidence, not a verified delivery.',
    'Run push again for a new attempt. Every attempt uses a fresh directory, so earlier attempt directories are never reused, and an operator must remove them if they are no longer wanted.',
    'If a guest tool or an ancestor directory was refused, correct the guest outside Qiln.',
  ),
  AWS_DEPLOYMENT_RELEASE_UNAVAILABLE: entry(
    'Release push is not available yet',
    'Delivering a published release is not implemented. The command stopped immediately: no deployment record, protected state, lock, key, AWS call, packaging step, or SSH connection was used, and nothing changed on any host. Qiln does not substitute the local working tree for a release.',
    'To deliver your current local development source, run qiln aws deployment push without --source release.',
  ),
  SOURCE_SELECTION_REFUSED: entry(
    'Source selection was refused',
    'Qiln packages only ordinary regular files from the Git working tree that contains the invoking directory. Sparse or skip-worktree checkouts, unresolved merges, nested repositories and submodules, symbolic links, special files, hard links, setuid, setgid, or sticky modes, unusual names, and sizes or counts over the limits are refused rather than worked around. A change detected between scanning and packaging is refused as well, because Qiln does not claim an atomic snapshot. Nothing was uploaded and nothing was changed on any host.',
    'Review the displayed reason, correct the working tree, and run the command again.',
    'Qiln does not retry, repair, or partially accept a selection.',
  ),
  SOURCE_ARCHIVE_FAILED: entry(
    'Source archive could not be captured',
    'Qiln captures the selected files into one private .tar.gz before any approval or upload. That capture did not complete, so no archive was approved or uploaded and nothing was changed on any host. The archive is not a published release or an atomic snapshot, and filename filtering is not proof that the source contains no secrets. If tar termination was not confirmed, its private work directory and the operation lock are retained, because tar may still be writing there.',
    'Review the displayed reason and run the command again once edits to the working tree have settled.',
    'If tar termination was not confirmed, confirm that no tar process is active before removing the retained work directory.',
    'Qiln does not retry or resume a failed capture.',
  ),
})
