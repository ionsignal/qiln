import { doctor } from './commands/doctor'
import { up, type UpCommandOptions } from './commands/up'
import { QilnInstallerError } from './error'
import { ProcessExecutionError } from './process'
import { Reporter, type ColorMode } from './reporter'
import type { InstallerImageSelection } from './install/image'

type Command =
  | {
      kind: 'help'
    }
  | {
      kind: 'version'
    }
  | {
      kind: 'doctor'
    }
  | {
      kind: 'up'
      options: UpCommandOptions
    }

interface Invocation {
  argumentsList: readonly string[]
  color: ColorMode
}

function usage(): string[] {
  return [
    'Usage:',
    '  qiln doctor',
    '  qiln up --source <checkout> --image <local-alias-or-full-fingerprint> [--authorized-keys <roster>]',
    '  qiln up --source <checkout> --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs> [--authorized-keys <roster>]',
    '',
    'Global options:',
    '  --color=auto|always|never  Control ANSI color output.',
    '',
    'Commands:',
    '  doctor   Validate the supported host, local Incus access, ZFS storage, networking, and existing installer state.',
    '  up       Converge and verify the stopped Qiln development installation.',
    '',
    'The --image path is non-destructive and accepts one existing local alias or full lowercase SHA-256 fingerprint.',
    'The split-image path explicitly authorizes replacement of the image targeted by the managed qiln-orchestrator-dev alias before importing or reusing the staged content.',
    'The first credential-set generation requires --authorized-keys. Later runs reuse retained credentials, and a supplied roster replaces only authorized_keys.',
    'Source deployment and service startup are not performed. The configured orchestrator remains stopped.',
    '',
    'Public Qiln commands must run as the unprivileged invoking developer and never invoke sudo or another privilege-escalation mechanism.',
  ]
}

function optionValue(argumentsList: readonly string[], index: number, option: string): string {
  const value = argumentsList[index + 1]
  if (value === undefined || value === '' || value.startsWith('-')) {
    throw new QilnInstallerError({
      code: 'INVALID_ARGUMENT',
      check: 'command-line arguments',
      summary: `${option} requires a value.`,
      observed: `No usable value followed ${option}.`,
      reason: 'The installer requires explicit, unambiguous input paths and image selection.',
      operatorAction: 'Review qiln --help and supply the missing value.',
      rerun: 'qiln --help',
    })
  }
  return value
}

function parseColor(value: string): ColorMode {
  if (value === 'auto' || value === 'always' || value === 'never') {
    return value
  }
  throw new QilnInstallerError({
    code: 'INVALID_COLOR_MODE',
    check: 'terminal color output',
    summary: 'The requested color mode is invalid.',
    observed: `Received '--color=${value || 'empty'}'.`,
    reason: 'Qiln accepts only explicit auto, always, or never color modes.',
    operatorAction: 'Use --color=auto, --color=always, or --color=never.',
    rerun: 'qiln --help',
  })
}

function parseInvocation(argumentsList: readonly string[]): Invocation {
  let color: ColorMode = 'auto'
  let colorSpecified = false
  const commandArguments: string[] = []
  for (const argument of argumentsList) {
    if (argument === '--color') {
      throw new QilnInstallerError({
        code: 'INVALID_COLOR_MODE',
        check: 'terminal color output',
        summary: '--color must include its mode with an equals sign.',
        observed: "Received '--color' without '=auto', '=always', or '=never'.",
        reason: 'Qiln accepts one explicit global color mode and does not infer an adjacent argument as its value.',
        operatorAction: 'Use --color=auto, --color=always, or --color=never.',
        rerun: 'qiln --help',
      })
    }
    if (argument.startsWith('--color=')) {
      if (colorSpecified) {
        throw duplicateOption('--color')
      }
      color = parseColor(argument.slice('--color='.length))
      colorSpecified = true
      continue
    }
    commandArguments.push(argument)
  }
  return {
    argumentsList: commandArguments,
    color,
  }
}

function parseUp(argumentsList: readonly string[]): Command {
  let sourcePath: string | undefined
  let imageReference: string | undefined
  let imageMetadataPath: string | undefined
  let imageRootfsPath: string | undefined
  let authorizedKeysPath: string | undefined
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index]
    if (argument === '--help' || argument === '-h') {
      return {
        kind: 'help',
      }
    }
    if (argument === '--source') {
      if (sourcePath !== undefined) {
        throw duplicateOption(argument)
      }
      sourcePath = optionValue(argumentsList, index, argument)
      index++
      continue
    }
    if (argument === '--image') {
      if (imageReference !== undefined) {
        throw duplicateOption(argument)
      }
      imageReference = optionValue(argumentsList, index, argument)
      index++
      continue
    }
    if (argument === '--image-meta') {
      if (imageMetadataPath !== undefined) {
        throw duplicateOption(argument)
      }
      imageMetadataPath = optionValue(argumentsList, index, argument)
      index++
      continue
    }
    if (argument === '--image-rootfs') {
      if (imageRootfsPath !== undefined) {
        throw duplicateOption(argument)
      }
      imageRootfsPath = optionValue(argumentsList, index, argument)
      index++
      continue
    }
    if (argument === '--image-file') {
      throw new QilnInstallerError({
        code: 'IMAGE_FILE_INTERFACE_RETIRED',
        check: 'qiln up image input',
        summary: 'The singular --image-file interface has been retired.',
        observed: '--image-file was supplied.',
        reason:
          'Incus split-image imports require explicit metadata and rootfs artifacts so Qiln can stage, bound, hash, and upload them in the required order.',
        operatorAction: 'Use --image-meta <incus.tar.xz> together with --image-rootfs <rootfs.squashfs>.',
        rerun:
          'qiln up --source <checkout> --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs> [--authorized-keys <roster>]',
      })
    }
    if (argument === '--authorized-keys') {
      if (authorizedKeysPath !== undefined) {
        throw duplicateOption(argument)
      }
      authorizedKeysPath = optionValue(argumentsList, index, argument)
      index++
      continue
    }
    throw new QilnInstallerError({
      code: 'INVALID_ARGUMENT',
      check: 'qiln up arguments',
      summary: `Unknown qiln up argument '${argument}'.`,
      observed: 'The command contains an option not owned by the current installer interface.',
      reason: 'Qiln fails closed rather than ignoring installation options.',
      operatorAction: 'Review qiln --help and remove the unsupported argument.',
      rerun: 'qiln --help',
    })
  }
  if (sourcePath === undefined) {
    throw new QilnInstallerError({
      code: 'SOURCE_REQUIRED',
      check: 'qiln up source input',
      summary: '--source is required.',
      observed: 'No host Qiln checkout was selected.',
      reason: 'The local host monorepo remains the canonical source working copy.',
      operatorAction: 'Pass the Qiln Git checkout root with --source.',
      rerun: 'qiln up --source <checkout> --image <alias-or-fingerprint>',
    })
  }
  const hasReference = imageReference !== undefined
  const hasMetadata = imageMetadataPath !== undefined
  const hasRootfs = imageRootfsPath !== undefined
  if (hasMetadata !== hasRootfs) {
    throw new QilnInstallerError({
      code: 'SPLIT_IMAGE_PAIR_REQUIRED',
      check: 'qiln up split-image input',
      summary: '--image-meta and --image-rootfs must be supplied together.',
      observed: hasMetadata ? '--image-rootfs is missing.' : '--image-meta is missing.',
      reason: 'The split Incus image fingerprint and multipart import require both ordered artifacts.',
      operatorAction: 'Supply both split-image paths or use --image with an existing local image.',
      rerun:
        'qiln up --source <checkout> --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs> [--authorized-keys <roster>]',
    })
  }
  if (hasReference === hasMetadata) {
    throw new QilnInstallerError({
      code: 'IMAGE_SELECTION_REQUIRED',
      check: 'qiln up image input',
      summary: 'Select exactly one image input form.',
      observed: hasReference
        ? '--image cannot be combined with --image-meta and --image-rootfs.'
        : 'No complete image input was supplied.',
      reason:
        'One explicit non-destructive reference or one explicit split-image replacement must define the installation image pin.',
      operatorAction:
        'Use either --image <alias-or-fingerprint> or the paired --image-meta and --image-rootfs options.',
      rerun: 'qiln --help',
    })
  }
  const image: InstallerImageSelection =
    imageReference !== undefined
      ? {
          kind: 'reference',
          value: imageReference,
        }
      : {
          kind: 'split',
          metadataPath: imageMetadataPath!,
          rootfsPath: imageRootfsPath!,
        }
  return {
    kind: 'up',
    options: {
      sourcePath,
      image,
      ...(authorizedKeysPath === undefined ? {} : { authorizedKeysPath }),
    },
  }
}

function duplicateOption(option: string): QilnInstallerError {
  return new QilnInstallerError({
    code: 'DUPLICATE_ARGUMENT',
    check: 'command-line arguments',
    summary: `${option} may be supplied only once.`,
    observed: `The command contains repeated ${option} options.`,
    reason: 'Qiln does not infer precedence between duplicate installation inputs.',
    operatorAction: `Remove the duplicate ${option} option.`,
    rerun: 'qiln --help',
  })
}

function parseCommand(argumentsList: readonly string[]): Command {
  if (argumentsList.length === 0 || argumentsList[0] === '--help' || argumentsList[0] === '-h') {
    return {
      kind: 'help',
    }
  }
  if (argumentsList[0] === '--version' || argumentsList[0] === '-v') {
    if (argumentsList.length !== 1) {
      throw new QilnInstallerError({
        code: 'INVALID_ARGUMENT',
        check: 'version command arguments',
        summary: '--version does not accept additional arguments.',
        observed: 'Additional command-line values followed --version.',
        reason: 'The version command has no installation inputs.',
        operatorAction: 'Run qiln --version without additional arguments.',
        rerun: 'qiln --version',
      })
    }
    return {
      kind: 'version',
    }
  }
  switch (argumentsList[0]) {
    case 'doctor':
      if (argumentsList.length !== 1) {
        throw new QilnInstallerError({
          code: 'INVALID_ARGUMENT',
          check: 'qiln doctor arguments',
          summary: 'qiln doctor does not accept installation inputs.',
          observed: 'Additional command-line values followed qiln doctor.',
          reason: 'Image, source, and credential inputs belong to the explicit qiln up workflow.',
          operatorAction: 'Run qiln doctor without additional arguments.',
          rerun: 'qiln doctor',
        })
      }
      return {
        kind: 'doctor',
      }
    case 'up':
      return parseUp(argumentsList.slice(1))
    case 'source':
    case 'status':
    case 'stop':
    case 'destroy':
      throw new QilnInstallerError({
        code: 'FEATURE_DEFERRED',
        check: `qiln ${argumentsList[0]} availability`,
        summary: `The '${argumentsList[0]}' command is not part of the current installer interface.`,
        observed: 'The requested high-level management command is reserved for later work.',
        reason: 'The current CLI supports read-only diagnostics and stopped installation convergence.',
        operatorAction: 'Use qiln doctor or qiln up.',
        rerun: 'qiln --help',
      })
    default:
      throw new QilnInstallerError({
        code: 'UNKNOWN_COMMAND',
        check: 'command selection',
        summary: `Unknown Qiln command '${argumentsList[0]}'.`,
        observed: 'The requested command is not part of the installer interface.',
        reason: 'Qiln fails closed rather than guessing the intended operation.',
        operatorAction: 'Review the available commands.',
        rerun: 'qiln --help',
      })
  }
}

function assertUnprivilegedInvocation(): void {
  if (typeof process.geteuid !== 'function' || typeof process.getuid !== 'function') {
    throw new QilnInstallerError({
      code: 'UNSUPPORTED_PLATFORM',
      check: 'public command privilege boundary',
      summary: 'Qiln cannot determine user ID and effective user ID on this platform.',
      observed: `Node platform '${process.platform}' does not expose process.getuid() and process.geteuid().`,
      reason: 'Public Qiln commands must prove that they are not running as root.',
      operatorAction: 'Run Qiln on the supported Ubuntu host as the invoking developer.',
      rerun: 'qiln doctor',
    })
  }
  if (process.getuid() === 0 || process.geteuid() === 0) {
    throw new QilnInstallerError({
      code: 'ROOT_EXECUTION_REFUSED',
      check: 'public command privilege boundary',
      summary: 'Qiln refuses to run as root.',
      observed: `The user ID is ${process.getuid()} and effective user ID is ${process.geteuid()}.`,
      reason:
        'The installer must use only the invoking developer’s existing local Incus authority and must never become a host-privileged administration path.',
      operatorAction:
        'Leave the root shell and run Qiln as the authorized unprivileged developer. Perform any required host administration separately and manually.',
      rerun: 'qiln doctor',
    })
  }
}

function rerun(argumentsList: readonly string[]): string {
  return argumentsList[0] === 'up'
    ? 'qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]'
    : 'qiln doctor'
}

function processFailure(error: ProcessExecutionError, argumentsList: readonly string[]): QilnInstallerError {
  const issue = {
    start: {
      code: 'PREFLIGHT_PROCESS_START_FAILED',
      summary: 'A required local command could not be started.',
      observed: `The required local '${error.command}' command could not be started.`,
      reason: 'Qiln cannot safely determine or generate required state when a required local command cannot start.',
      operatorAction: `Verify that '${error.command}' is installed, executable, and accessible to the invoking developer. Qiln will not install packages, alter PATH, or invoke privilege escalation.`,
    },
    timeout: {
      code: 'PREFLIGHT_PROCESS_TIMEOUT',
      summary: 'A required local command did not finish before its deadline.',
      observed: `The required local '${error.command}' command exceeded its bounded execution timeout.`,
      reason: 'Qiln cannot safely continue after an incomplete local operation.',
      operatorAction: `Inspect the local '${error.command}' command and the host state it requires, then resolve the delay manually. Qiln will not modify host services or invoke privilege escalation.`,
    },
    output: {
      code: 'PREFLIGHT_PROCESS_OUTPUT_LIMIT_EXCEEDED',
      summary: 'A required local command exceeded its bounded diagnostic output limit.',
      observed: `The required local '${error.command}' command produced more output than Qiln can safely retain.`,
      reason: 'Qiln cannot safely interpret an unbounded local command response.',
      operatorAction: `Inspect the local '${error.command}' command and its host configuration manually. Qiln will not suppress, rewrite, or retry an unbounded response automatically.`,
    },
  }[error.kind]
  return new QilnInstallerError({
    code: issue.code,
    check: 'local command execution',
    summary: issue.summary,
    observed: issue.observed,
    reason: issue.reason,
    operatorAction: issue.operatorAction,
    rerun: rerun(argumentsList),
    cause: error,
  })
}

export async function run(argumentsList: readonly string[]): Promise<number> {
  let reporter = new Reporter()
  let commandArguments = argumentsList
  try {
    const invocation = parseInvocation(argumentsList)
    commandArguments = invocation.argumentsList
    reporter = new Reporter({
      color: invocation.color,
    })
    assertUnprivilegedInvocation()
    const command = parseCommand(commandArguments)
    if (command.kind === 'help') {
      reporter.help(usage())
      return 0
    }
    if (command.kind === 'version') {
      reporter.version('0.1.2')
      return 0
    }
    if (command.kind === 'doctor') {
      reporter.header('doctor', 'read-only preflight')
      await doctor(reporter)
      return 0
    }
    reporter.header('up', 'stopped installation convergence')
    await up(command.options, reporter)
    return 0
  } catch (error: unknown) {
    reporter.failure(error instanceof ProcessExecutionError ? processFailure(error, commandArguments) : error)
    return 1
  }
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2))
}

void main()
