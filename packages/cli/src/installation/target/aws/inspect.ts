import { z } from 'zod'
import inspectScript from './scripts/inspect.sh?raw'
import { outputOf, type Section } from '../../../remote/output'
import { parseOsRelease } from '../../../remote/parse'
import { shellCommand } from '../../../remote/shell'
import { InstallerError } from '../../../diagnostic/error'
import type { CheckoutObservation, HostObservation } from '../../host'
import type { Remote } from '../../../ssh/connections'

const LIMITS = {
  timeoutMs: 30_000,
  maxOutputBytes: 65_536,
}

/**
 * Carries only authored wording. Raw output, paths, and tool messages never
 * enter the diagnostic.
 */
function failure(reason: string): InstallerError {
  return new InstallerError({
    code: 'INSTALLATION_HOST_INSPECTION_FAILED',
    facts: [['Reason', reason]],
  })
}

const { fields, sections, succeeded, yesNo } = outputOf(failure)

const systemSchema = z.object({
  kernel: z.string().min(1),
  machine: z.string().min(1),
  packageArchitecture: z.string().min(1),
  memTotalKiB: z.coerce.number().int().positive(),
})

function checkoutOf(section: Section): CheckoutObservation | null {
  const values = fields(section.lines)
  if (!yesNo(values.get('present'), 'checkout presence')) {
    return null
  }
  const path = values.get('path')
  if (!path) {
    throw failure('The checkout path was not reported.')
  }
  const commit = values.get('commit') || null
  if (commit !== null && !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw failure('The checkout commit was not in the expected form.')
  }
  return {
    path,
    gitRoot: values.get('toplevel') || null,
    commit,
    packageName: values.get('packageName') || null,
  }
}

/**
 * Runs the fixed read-only inspection as the connected account, without sudo,
 * and validates its output. `checkoutPath` is resolved on the target, never on
 * the operator's machine. Transport failures propagate unchanged.
 */
export async function inspectHost(remote: Remote, checkoutPath: string | null): Promise<HostObservation> {
  const result = await remote.exec(shellCommand(inspectScript, [checkoutPath ?? '']), LIMITS)
  if (result.exitCode !== 0) {
    throw failure(`The inspection script exited with code ${result.exitCode}.`)
  }
  const found = sections(result.stdout)
  const system = systemSchema.safeParse(Object.fromEntries(fields(succeeded(found, 'system').lines)))
  if (!system.success) {
    throw failure('The system section was missing a field or out of range.')
  }
  const release = parseOsRelease(succeeded(found, 'osrelease').lines.join('\n'))
  if (release === null) {
    throw failure('The operating-system release could not be read.')
  }
  return {
    distributionId: release.id,
    distributionVersion: release.versionId,
    kernelRelease: system.data.kernel,
    packageArchitecture: system.data.packageArchitecture,
    machine: system.data.machine,
    memoryBytes: system.data.memTotalKiB * 1_024,
    checkout: checkoutPath === null ? null : checkoutOf(succeeded(found, 'checkout')),
  }
}
