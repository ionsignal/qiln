import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import type { Dir } from '../../state/files'
import { runSetup, type SetupOptions } from '../../transport/subprocess/setup'
import { TOOL_SPEC } from './spec'
import * as state from './state'

// An absolute path, so a PATH entry can never stand in for the verifier.
const PKGUTIL = '/usr/sbin/pkgutil'
const PAYLOAD = 'aws-cli'
const SIGNER = new RegExp(`^\\s+1\\. Developer ID Installer: .+ \\(${TOOL_SPEC.signerTeamId}\\)\\s*$`, 'm')
const NOTARIZED = /^\s*Notarization: trusted by the Apple notary service\s*$/m

/**
 * The SHA-256 pin is the primary identity. The signature is an independent
 * provenance check, judged from the tool's output rather than its exit code.
 */
async function verifySignature(archive: string, options: SetupOptions): Promise<void> {
  const { stdout } = await runSetup(PKGUTIL, ['--check-signature', archive], options)
  if (!SIGNER.test(stdout) || !NOTARIZED.test(stdout)) {
    throw new InstallerError({
      code: 'AWS_TOOL_VERIFICATION_FAILED',
      facts: [['Observed', 'The package signer or notarization does not match the pinned release.']],
    })
  }
}

/**
 * Expands the package without running the macOS installer or its scripts, so
 * nothing needs privileges. The workspace lives inside the target, which keeps
 * the final move on one filesystem and the vendor code signatures intact.
 */
export async function setupPkg(target: Dir, workspace: Dir, archive: string, options: SetupOptions): Promise<void> {
  await verifySignature(archive, options)
  const expanded = workspace.child('expanded')
  await runSetup(PKGUTIL, ['--expand-full', archive, expanded], options)
  const payload = join(expanded, 'aws-cli.pkg/Payload')
  const names = await readdir(payload)
  if (names.length !== 1 || names[0] !== PAYLOAD) {
    throw new InstallerError({
      code: 'AWS_TOOL_PAYLOAD_INVALID',
    })
  }
  await state.tree(payload, [])
  await rename(join(payload, PAYLOAD), target.child(PAYLOAD))
  await target.sync()
}
