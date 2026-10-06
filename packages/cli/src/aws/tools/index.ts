import { realpath } from 'node:fs/promises'
import { InstallerError } from '../../diagnostic/error'
import { findExecutable, SetupExecutionError } from '../../process'
import { checkCancellation } from '../../terminal/prompts'
import { isErrorCode, toolDiagnostic, toolRecovery } from '../errors'
import { inspect, type AwsCli } from '../auth/login'
import { requireAwsHost } from '../state'
import { environment, install as installTool, verify, type InstallOptions } from './install'
import { current, RELEASE, TOOL_SPEC, type Artifact, type TargetId } from './spec'
import * as state from './state'

export interface ExternalRejection {
  version: string | null
  reason: 'incompatible' | 'inspection-failed'
}

export interface Proposal {
  version: string
  target: TargetId
  artifact: Artifact
  destination: string
  effects: readonly string[]
}

export type Selection =
  | {
      kind: 'external' | 'managed'
      cli: AwsCli
      rejected?: ExternalRejection
    }
  | {
      kind: 'proposal'
      proposal: Proposal
      rejected?: ExternalRejection
    }

function check(signal?: AbortSignal): void {
  if (signal) {
    checkCancellation(signal)
  }
}

async function isManagedExecutable(executable: string): Promise<boolean> {
  const tools = state.toolsPath()
  if (state.contains(tools, executable)) {
    return true
  }
  try {
    return state.contains(await realpath(tools), executable)
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return false
    }
    throw new InstallerError({
      code: 'AWS_TOOL_STATE_INVALID',
      facts: [['Observed', 'The managed tool directory could not be resolved safely for executable selection.']],
      retry: 'qiln aws connect',
    })
  }
}

function proposal(): Proposal {
  return {
    version: TOOL_SPEC.version,
    target: RELEASE.target,
    artifact: {
      ...RELEASE.artifact,
    },
    destination: state.location(),
    effects: [...RELEASE.effects],
  }
}

/**
 * No state is created or modified here. An executable inside managed storage
 * cannot bypass record and payload validation by appearing on PATH.
 */
export async function resolve(signal?: AbortSignal): Promise<Selection> {
  requireAwsHost()
  check(signal)
  let rejected: ExternalRejection | undefined
  const external = await findExecutable('aws')
  check(signal)
  if (external && !(await isManagedExecutable(external))) {
    try {
      const inspected = await inspect(external, {
        environment: environment(),
        signal,
      })
      check(signal)
      if (inspected.compatible && inspected.version !== null) {
        return {
          kind: 'external',
          cli: {
            executable: external,
            version: inspected.version,
          },
        }
      }
      rejected = {
        version: inspected.version,
        reason: 'incompatible',
      }
    } catch (error: unknown) {
      if (error instanceof SetupExecutionError) {
        if (!error.terminationConfirmed) {
          throw toolRecovery(
            toolDiagnostic(error),
            {
              termination: false,
              cleanup: 'not-required',
              persistence: 'not-required',
              lock: 'not-required',
            },
            external,
          )
        }
        if (error.kind === 'cancelled') {
          throw toolDiagnostic(error)
        }
      }
      check(signal)
      if (error instanceof InstallerError && error.code === 'COMMAND_CANCELLED') {
        throw error
      }
      rejected = {
        version: null,
        reason: 'inspection-failed',
      }
    }
  }
  check(signal)
  current()
  try {
    const tools = await state.open()
    if (tools) {
      await state.unlocked(tools)
      const ready = await state.read(tools)
      if (ready) {
        const cli = await verify(ready.executable, signal)
        check(signal)
        await state.unlocked(tools)
        check(signal)
        return {
          kind: 'managed',
          cli,
          ...(rejected === undefined ? {} : { rejected }),
        }
      }
    }
    check(signal)
    return {
      kind: 'proposal',
      proposal: proposal(),
      ...(rejected === undefined ? {} : { rejected }),
    }
  } catch (error: unknown) {
    if (error instanceof SetupExecutionError && !error.terminationConfirmed) {
      throw toolRecovery(
        toolDiagnostic(error),
        {
          termination: false,
          cleanup: 'not-required',
          persistence: 'not-required',
          lock: 'not-required',
        },
        state.location(),
      )
    }
    throw toolDiagnostic(error)
  }
}

/**
 * Call only after presenting the proposal and receiving explicit approval. The
 * supplied proposal cannot replace the pinned artifact or installation policy.
 */
export async function install(approved: Proposal, options: InstallOptions = {}): Promise<AwsCli> {
  requireAwsHost()
  check(options.signal)
  current()
  const expected = proposal()
  if (
    approved.version !== expected.version ||
    approved.target !== expected.target ||
    approved.destination !== expected.destination ||
    approved.artifact.url !== expected.artifact.url ||
    approved.artifact.format !== expected.artifact.format ||
    approved.artifact.bytes !== expected.artifact.bytes ||
    approved.artifact.sha256 !== expected.artifact.sha256 ||
    approved.effects.length !== expected.effects.length ||
    approved.effects.some((effect, index) => effect !== expected.effects[index])
  ) {
    throw new InstallerError({
      code: 'AWS_TOOL_STATE_INVALID',
      facts: [['Observed', 'The approved proposal differs from the pinned installation policy.']],
    })
  }
  return await installTool(options)
}

export type { InstallOptions, Progress } from './install'
