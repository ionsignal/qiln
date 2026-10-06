import { constants } from 'node:fs'
import { access, lstat, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { InstallerError } from '../../diagnostic/error'
import { findExecutable, runSetup, SetupExecutionError, type SetupOptions } from '../../process'
import { openChildDir, type Dir } from '../../state/files'
import { checkCancellation } from '../../terminal/prompts'
import { toolDiagnostic, toolRecovery, type ToolRecoveryOutcomes } from '../errors'
import { inspect, type AwsCli } from '../auth/login'
import { userId } from '../state'
import { download, DownloadError } from './download'
import { current, TOOL_SPEC, type Release } from './spec'
import * as state from './state'

export type Progress =
  | {
      stage: 'downloading'
      received: number
      total: number
    }
  | {
      stage: 'artifact-verified' | 'installing' | 'installation-verified' | 'ready'
    }

export interface InstallOptions {
  signal?: AbortSignal
  progress?: (event: Progress) => void
}

function check(signal?: AbortSignal): void {
  if (signal) {
    checkCancellation(signal)
  }
}

function emit(options: InstallOptions, event: Progress): void {
  try {
    options.progress?.(event)
  } catch {
    // Presentation cannot decide whether a verified installation is usable.
  }
}

export function environment(workspace?: string): NodeJS.ProcessEnv {
  const path = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')
    .split(':')
    .filter(entry => isAbsolute(entry))
    .join(':')
  return {
    PATH: path,
    HOME: process.env.HOME,
    ...(workspace === undefined ? {} : { TMPDIR: workspace }),
    LANG: 'C',
    LC_ALL: 'C',
    AWS_CLI_AGENT_TOOLKIT_HINT_DISABLED: 'true',
    AWS_CLI_AUTO_PROMPT: 'off',
    AWS_PAGER: '',
    AWS_EC2_METADATA_DISABLED: 'true',
  }
}

function setupOptions(workspace: Dir, options: InstallOptions): SetupOptions {
  return {
    cwd: workspace.path,
    environment: environment(workspace.path),
    signal: options.signal,
    timeoutMs: TOOL_SPEC.setupTimeoutMs,
    maxOutputBytes: TOOL_SPEC.maximumOutputBytes,
  }
}

async function prerequisite(name: string): Promise<string> {
  const executable = await findExecutable(name)
  if (!executable) {
    throw new InstallerError({
      code: 'AWS_TOOL_PREREQUISITE_MISSING',
      facts: [['Tool', name]],
      retry: 'qiln aws connect',
    })
  }
  return executable
}

async function prerequisites(): Promise<string> {
  for (const name of ['cp', 'mkdir', 'ln', 'cut', 'dirname', 'cat', 'sh']) {
    await prerequisite(name)
  }
  return await prerequisite('unzip')
}

export async function verify(executable: string, signal?: AbortSignal, workspace?: string): Promise<AwsCli> {
  const result = await inspect(executable, {
    environment: environment(workspace),
    signal,
  })
  if (!result.compatible || result.version === null) {
    throw new InstallerError({
      code: 'AWS_TOOL_VERSION_INVALID',
      facts: [
        ['Detected version', result.version ?? 'unrecognized'],
        ['Required version', TOOL_SPEC.version],
      ],
      retry: 'qiln aws connect',
    })
  }
  return {
    executable,
    version: result.version,
  }
}

async function setup(
  release: Release,
  target: Dir,
  workspace: Dir,
  archive: string,
  unzip: string,
  options: InstallOptions,
): Promise<void> {
  const extracted = await openChildDir(
    workspace,
    'extracted',
    {
      owner: userId(),
      mode: 0o700,
    },
    true,
  )
  await runSetup(unzip, ['-q', archive, '-d', extracted.path], setupOptions(workspace, options))
  const names = await extracted.list()
  if (names.length !== 1 || names[0] !== 'aws') {
    throw new InstallerError({
      code: 'AWS_TOOL_PAYLOAD_INVALID',
    })
  }
  await state.tree(extracted.path, release.archiveLinks)
  const bundled = join(extracted.path, 'aws/dist/aws')
  const installer = join(extracted.path, 'aws/install')
  if (!(await lstat(bundled)).isFile() || !(await lstat(installer)).isFile()) {
    throw new InstallerError({
      code: 'AWS_TOOL_PAYLOAD_INVALID',
    })
  }
  await access(installer, constants.X_OK)
  await verify(bundled, options.signal, workspace.path)
  check(options.signal)
  await runSetup(
    installer,
    ['--install-dir', target.child('aws-cli'), '--bin-dir', target.child('bin')],
    setupOptions(workspace, options),
  )
}

/**
 * Installation is called only after command-layer approval. Every executable,
 * artifact identity, and destination is re-derived from the pinned release.
 */
export async function install(options: InstallOptions = {}): Promise<AwsCli> {
  check(options.signal)
  const release = current()
  state.location()
  const unzip = await prerequisites()
  check(options.signal)
  const tools = await state.open(true)
  if (!tools) {
    throw new InstallerError({
      code: 'AWS_TOOL_STATE_INVALID',
    })
  }
  const lock = await state.lock(tools)
  const outcomes: ToolRecoveryOutcomes = {
    termination: true,
    cleanup: 'not-required',
    persistence: 'not-required',
    lock: false,
  }
  let target: Dir | undefined
  let record: state.InstallationRecord | undefined
  let workspaceStarted = false
  let inputsClosed = true
  let failure: InstallerError | undefined
  let cli: AwsCli | undefined
  try {
    check(options.signal)
    const existing = await state.read(tools)
    if (existing) {
      cli = await verify(existing.executable, options.signal)
    } else {
      target = await state.create(tools)
      const startedAt = new Date().toISOString()
      record = {
        version: 1,
        cliVersion: TOOL_SPEC.version,
        target: release.target,
        phase: 'installing',
        artifact: state.artifactIdentity(release.artifact),
        startedAt,
        updatedAt: startedAt,
        failureCode: null,
        // An interrupted installing record never asserts that setup was inactive.
        termination: 'unconfirmed',
        cleanup: 'unconfirmed',
      }
      await state.write(target, record)
      workspaceStarted = true
      outcomes.cleanup = false
      const workspace = await openChildDir(
        target,
        TOOL_SPEC.state.workspace,
        {
          owner: userId(),
          mode: 0o700,
        },
        true,
      )
      emit(options, {
        stage: 'downloading',
        received: 0,
        total: release.artifact.bytes,
      })
      const archive = await download(release.artifact, workspace, 'artifact.zip', {
        signal: options.signal,
        progress(received, total) {
          emit(options, {
            stage: 'downloading',
            received,
            total,
          })
        },
      })
      emit(options, {
        stage: 'artifact-verified',
      })
      check(options.signal)
      emit(options, {
        stage: 'installing',
      })
      await setup(release, target, workspace, archive, unzip, options)
      check(options.signal)
      cli = await verify(await state.executable(target, release), options.signal, workspace.path)
      emit(options, {
        stage: 'installation-verified',
      })
      check(options.signal)
      await rm(target.child(TOOL_SPEC.state.workspace), {
        recursive: true,
      })
      await target.sync()
      if ((await target.list()).includes(TOOL_SPEC.state.workspace)) {
        throw new InstallerError({
          code: 'AWS_TOOL_CLEANUP_FAILED',
        })
      }
      outcomes.cleanup = true
      check(options.signal)
      await state.write(target, {
        ...record,
        phase: 'ready',
        updatedAt: new Date().toISOString(),
        termination: 'confirmed',
        cleanup: 'completed',
      })
    }
    check(options.signal)
  } catch (error: unknown) {
    failure = toolDiagnostic(error)
    if (error instanceof SetupExecutionError) {
      outcomes.termination = error.terminationConfirmed
    }
    if (error instanceof DownloadError) {
      inputsClosed = error.fileClosed
    }
    if (target && workspaceStarted && outcomes.cleanup !== true) {
      if (outcomes.termination && inputsClosed) {
        try {
          await rm(target.child(TOOL_SPEC.state.workspace), {
            recursive: true,
            force: true,
          })
          await target.sync()
          outcomes.cleanup = !(await target.list()).includes(TOOL_SPEC.state.workspace)
        } catch {
          outcomes.cleanup = false
        }
      } else {
        outcomes.cleanup = false
      }
    }
    if (target && record) {
      outcomes.persistence = false
      try {
        await state.write(target, {
          ...record,
          phase: 'failed',
          updatedAt: new Date().toISOString(),
          failureCode: failure.code,
          termination: outcomes.termination ? 'confirmed' : 'unconfirmed',
          cleanup: outcomes.cleanup === true ? 'completed' : 'unconfirmed',
        })
        outcomes.persistence = true
      } catch {
        outcomes.persistence = false
      }
    }
  }
  if (outcomes.termination && inputsClosed) {
    try {
      await lock.release()
      outcomes.lock = true
    } catch {
      failure ??= new InstallerError({
        code: 'AWS_TOOL_LOCK_FAILED',
        facts: [['Observed', 'Managed-tool lock release or directory synchronization was not confirmed.']],
      })
    }
  }
  if (failure) {
    throw toolRecovery(failure, outcomes, state.location())
  }
  if (!cli) {
    throw toolRecovery(
      new InstallerError({
        code: 'AWS_TOOL_INSTALL_FAILED',
      }),
      outcomes,
      state.location(),
    )
  }
  emit(options, {
    stage: 'ready',
  })
  return cli
}
