import { Command, Option } from 'commander'
import { InstallerError } from './diagnostic/error'
import { convertUpOptions } from './input'
import type { CommanderError } from 'commander'
import type { UpCommandOptions } from './commands/up'
import type { UpInput } from './input'
import type { ColorMode } from './terminal/reporter'

export interface GlobalOptions {
  color: ColorMode
}

export interface ProgramHandlers {
  doctor(color: ColorMode): void | Promise<void>
  up(options: UpCommandOptions, color: ColorMode): void | Promise<void>
}

export interface ProgramOutput {
  write(text: string): void
}

const INSTALLATION_HELP = [
  'The --image path is non-destructive and accepts one existing local alias or full lowercase SHA-256 fingerprint.',
  'The split-image path explicitly authorizes replacement of the image targeted by the managed qiln-orchestrator-dev alias before importing or reusing the staged content.',
  'The first credential-set generation requires --authorized-keys. Later runs reuse retained credentials, and a supplied roster replaces only authorized_keys.',
  'The validated host checkout is attached as a writable shifted source device. Source copying and service startup are not performed. The configured orchestrator remains stopped.',
].join('\n')

function addSingleOption(command: Command, option: Option): void {
  let supplied = false
  command.addOption(option)
  // Commander owns option recognition and value parsing. Its option event
  // enforces single occurrence without introducing another argv parser.
  command.on(`option:${option.name()}`, () => {
    if (supplied) {
      const flag = `--${option.name()}`
      throw new InstallerError({
        code: 'DUPLICATE_ARGUMENT',
        facts: [['Option', flag]],
        retry: 'qiln --help',
      })
    }
    supplied = true
  })
}

/**
 * Each invocation receives a fresh program so parsed values and duplicate
 * detection cannot leak into another execution.
 */
export function createProgram(handlers: ProgramHandlers, output: ProgramOutput): Command {
  const program = new Command()
  program
    .name('qiln')
    .description('Configure and verify the Qiln development installation.')
    .version('0.1.2', '-v, --version', 'Display the Qiln version.')
    .helpOption('-h, --help', 'Display help.')
    .addHelpCommand(false)
    .allowExcessArguments(false)
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: text => output.write(text),
      writeErr: text => output.write(text),
      outputError: () => {},
    })
  addSingleOption(
    program,
    new Option('--color <mode>', 'Control ANSI color output.').choices(['auto', 'always', 'never']).default('auto'),
  )
  program.addHelpText(
    'after',
    [
      '',
      INSTALLATION_HELP,
      '',
      'Operational commands must run as the unprivileged invoking developer and never invoke sudo or another privilege-escalation mechanism.',
    ].join('\n'),
  )
  program
    .command('doctor')
    .description(
      'Validate the supported host, local Incus access, ZFS storage, networking, and existing installer state.',
    )
    .allowExcessArguments(false)
    .action(() => handlers.doctor(program.opts<GlobalOptions>().color))
  const up = program
    .command('up')
    .description('Converge and verify the stopped Qiln development installation.')
    .allowExcessArguments(false)
  addSingleOption(up, new Option('--source <checkout>', 'Select the canonical local Qiln Git checkout root.'))
  addSingleOption(
    up,
    new Option('--image <alias-or-fingerprint>', 'Select an existing local image alias or full lowercase fingerprint.'),
  )
  addSingleOption(
    up,
    new Option('--image-meta <metadata>', 'Select the metadata artifact for explicit split-image replacement.'),
  )
  addSingleOption(
    up,
    new Option('--image-rootfs <rootfs>', 'Select the rootfs artifact for explicit split-image replacement.'),
  )
  addSingleOption(
    up,
    new Option('--authorized-keys <roster>', 'Select the developer-owned orchestrator SSH public-key roster.'),
  )
  // Optional arity preserves the retirement diagnostic even when no value is
  // supplied to the old interface.
  addSingleOption(up, new Option('--image-file [file]', 'Retired image input.').hideHelp())
  up.addHelpText(
    'after',
    [
      '',
      'Image workflows:',
      '  qiln up --source <checkout> --image <alias-or-fingerprint> [--authorized-keys <roster>]',
      '  qiln up --source <checkout> --image-meta <metadata> --image-rootfs <rootfs> [--authorized-keys <roster>]',
      '',
      INSTALLATION_HELP,
    ].join('\n'),
  )
  up.action(() => handlers.up(convertUpOptions(up.opts<UpInput>()), program.opts<GlobalOptions>().color))
  return program
}

/**
 * Commander diagnostics are mapped only after parsing has stopped. Its error
 * writer is suppressed, leaving the existing Qiln renderer authoritative.
 */
export function parserFailure(error: CommanderError): InstallerError {
  if (error.code === 'commander.invalidArgument') {
    return new InstallerError({
      code: 'INVALID_COLOR_MODE',
      facts: [['Option', '--color']],
      retry: 'qiln --help',
    })
  }
  if (error.code === 'commander.unknownCommand') {
    return new InstallerError({
      code: 'UNKNOWN_COMMAND',
      retry: 'qiln --help',
    })
  }
  return new InstallerError({
    code: 'INVALID_ARGUMENT',
    retry: 'qiln --help',
  })
}
