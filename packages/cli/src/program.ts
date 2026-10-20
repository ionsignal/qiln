import { AWS_SPEC } from './aws/spec'
import { Command, Option } from 'commander'
import { InstallerError } from './diagnostic/error'
import {
  convertAwsDeploymentCreateOptions,
  convertAwsDeploymentOptions,
  convertAwsOptions,
  convertUpOptions,
} from './input'
import { configureHelp } from './terminal/help'
import { Reporter, type ColorMode, type OutputStream } from './terminal/reporter'
import * as help from './commands/help'
import * as awsHelp from './commands/aws/help'
import * as deploymentHelp from './commands/aws/deployment/help'
import type {
  AwsCommandOptions,
  AwsDeploymentCreateInput,
  AwsDeploymentCreateOptions,
  AwsDeploymentInput,
  AwsDeploymentOptions,
  AwsInput,
  UpInput,
} from './input'
import type { CommanderError } from 'commander'
import type { UpCommandOptions } from './commands/up'

export interface GlobalOptions {
  color: ColorMode
}

export interface ProgramHandlers {
  doctor(color: ColorMode): void | Promise<void>
  up(options: UpCommandOptions, color: ColorMode): void | Promise<void>
  aws?: {
    connect(options: AwsCommandOptions, color: ColorMode): void | Promise<void>
    status(options: AwsCommandOptions, color: ColorMode): void | Promise<void>
    disconnect(options: AwsCommandOptions, color: ColorMode): void | Promise<void>
    deployment: {
      create(options: AwsDeploymentCreateOptions, color: ColorMode): void | Promise<void>
      status(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
      list(color: ColorMode): void | Promise<void>
      inspect(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
      ssh(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
      remove(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
    }
  }
}

export interface ProgramOutput {
  write(text: string, stream: OutputStream): void
}

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

/** The ID and the alias are alternatives. The converter rejects supplying both. */
function addSelectorOptions(command: Command): void {
  addSingleOption(command, new Option('--id <deployment-id>', 'Select the deployment by the ID shown by list.'))
  addSingleOption(
    command,
    new Option('--alias <alias>', `Select the deployment by its local alias (default: ${AWS_SPEC.deployment.defaultName}).`),
  )
}

/**
 * Each invocation receives a fresh program so parsed values and duplicate
 * detection cannot leak into another execution.
 */
export function createProgram(handlers: ProgramHandlers, output: ProgramOutput): Command {
  const program = new Command()
  program
    .name('qiln')
    .description(
      'Manage the Qiln development installation, AWS operator connections, and AWS deployments.',
    )
    .version('0.1.2', '-v, --version', 'Display the Qiln version.')
    .helpOption('-h, --help', 'Display help.')
    .helpCommand(false)
    .allowExcessArguments(false)
    .showHelpAfterError(false)
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: text => output.write(text, 'stdout'),
      writeErr: text => output.write(text, 'stderr'),
      outputError: () => {},
    })
  addSingleOption(
    program,
    new Option('--color <mode>', 'Control ANSI color output.').choices(['auto', 'always', 'never']).default('auto'),
  )
  const describeHelp = configureHelp(
    program,
    () =>
      new Reporter({
        color: program.opts<GlobalOptions>().color,
      }),
  )
  describeHelp(program, help.root(handlers.aws !== undefined))
  const doctor = program
    .command('doctor')
    .description(
      'Inspect the supported host, local Incus access, ZFS storage, networking, and existing installer state.',
    )
    .summary('Inspect the development host without changes.')
    .action(() => handlers.doctor(program.opts<GlobalOptions>().color))
  describeHelp(doctor, help.doctor)
  const up = program
    .command('up')
    .description('Configure and verify the Qiln development installation, leaving the orchestrator stopped.')
    .summary('Configure the stopped development installation.')
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
  describeHelp(up, help.up)
  up.action(() => handlers.up(convertUpOptions(up.opts<UpInput>()), program.opts<GlobalOptions>().color))
  const awsHandlers = handlers.aws
  if (awsHandlers) {
    const aws = program
      .command('aws')
      .description('Manage Qiln-owned local AWS operator connections and approved host deployments.')
      .summary('Manage AWS connections and deployments.')
    describeHelp(aws, awsHelp.group)
    const connect = aws
      .command('connect')
      .description(
        'Save a verified operator login and offer explicitly approved creation or permission-only bootstrap.',
      )
      .summary('Connect an operator and review Qiln-managed permissions.')
    addSingleOption(
      connect,
      new Option('--name <name>', `Select a connection name (default: ${AWS_SPEC.defaultName}).`),
    )
    describeHelp(connect, awsHelp.connect)
    connect.action(() =>
      awsHandlers.connect(convertAwsOptions(connect.opts<AwsInput>()), program.opts<GlobalOptions>().color),
    )
    const status = aws
      .command('status')
      .description('Verify saved AWS operator identities against their recorded account, ARN, and immutable user ID.')
      .summary('Verify saved connections; credentials may refresh.')
    addSingleOption(status, new Option('--name <name>', 'Inspect one connection; otherwise inspect all.'))
    describeHelp(status, awsHelp.status)
    status.action(() =>
      awsHandlers.status(convertAwsOptions(status.opts<AwsInput>()), program.opts<GlobalOptions>().color),
    )
    const disconnect = aws
      .command('disconnect')
      .description('Remove one Qiln-owned local AWS connection and authentication cache after confirmation.')
      .summary('Remove a local connection after confirmation.')
    addSingleOption(
      disconnect,
      new Option('--name <name>', `Select the local connection to remove (default: ${AWS_SPEC.defaultName}).`),
    )
    describeHelp(disconnect, awsHelp.disconnect)
    disconnect.action(() =>
      awsHandlers.disconnect(convertAwsOptions(disconnect.opts<AwsInput>()), program.opts<GlobalOptions>().color),
    )
    const deployment = aws
      .command('deployment')
      .description('Create one approved AWS host, and inspect or remove retained deployments bound to a Qiln-managed operator.')
      .summary('Create a host; manage retained deployments.')
    describeHelp(deployment, deploymentHelp.group)
    const create = deployment
      .command('create')
      .description('Review one proposed host from read-only AWS discovery and, after approval, provision it and verify AWS health.')
      .summary('Create one approved host.')
    addSingleOption(
      create,
      new Option('--name <name>', `Select the connection (default: ${AWS_SPEC.defaultName}).`),
    )
    addSingleOption(
      create,
      new Option(
        '--alias <alias>',
        `Select the local alias for the deployment (default: ${AWS_SPEC.deployment.defaultName}).`,
      ),
    )
    describeHelp(create, deploymentHelp.create)
    create.action(() =>
      awsHandlers.deployment.create(
        convertAwsDeploymentCreateOptions(create.opts<AwsDeploymentCreateInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
    const deploymentStatus = deployment
      .command('status')
      .description('Report the retained evidence for one deployment without authenticating or calling AWS.')
      .summary('Report local deployment evidence.')
    addSelectorOptions(deploymentStatus)
    describeHelp(deploymentStatus, deploymentHelp.status)
    deploymentStatus.action(() =>
      awsHandlers.deployment.status(
        convertAwsDeploymentOptions(deploymentStatus.opts<AwsDeploymentInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
    const list = deployment
      .command('list')
      .description('List every retained deployment with its recorded state, without authenticating or calling AWS.')
      .summary('List local deployment evidence.')
    describeHelp(list, deploymentHelp.list)
    list.action(() => awsHandlers.deployment.list(program.opts<GlobalOptions>().color))
    const inspect = deployment
      .command('inspect')
      .description('Authenticate as the recorded operator, observe the recorded resources, and retain the observation and, when due, one AWS health read.')
      .summary('Retain a fresh observation.')
    addSelectorOptions(inspect)
    describeHelp(inspect, deploymentHelp.inspect)
    inspect.action(() =>
      awsHandlers.deployment.inspect(
        convertAwsDeploymentOptions(inspect.opts<AwsDeploymentInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
    const ssh = deployment
      .command('ssh')
      .description('Retain the server host-key pin if needed, then verify the pinned host key and administrative key by running one fixed read-only command over SSH.')
      .summary('Verify SSH access with a pinned host key.')
    addSelectorOptions(ssh)
    describeHelp(ssh, deploymentHelp.ssh)
    ssh.action(() =>
      awsHandlers.deployment.ssh(
        convertAwsDeploymentOptions(ssh.opts<AwsDeploymentInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
    const remove = deployment
      .command('remove')
      .description('Approve and remove the removable recorded resources, then observe and retain their absence. Retained storage is not removed.')
      .summary('Remove one approved deployment.')
    addSelectorOptions(remove)
    describeHelp(remove, deploymentHelp.remove)
    remove.action(() =>
      awsHandlers.deployment.remove(
        convertAwsDeploymentOptions(remove.opts<AwsDeploymentInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
  }
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
