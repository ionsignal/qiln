import { AWS_SPEC } from './aws/spec'
import { Command, Option } from 'commander'
import { InstallerError } from './diagnostic/error'
import {
  convertAwsDeploymentCreateOptions,
  convertAwsDeploymentOptions,
  convertAwsOptions,
  convertInstallationConfigureOptions,
  convertInstallationSelector,
  convertReassignSelector,
} from './input'
import { configureHelp } from './terminal/help'
import { Reporter, type ColorMode, type OutputStream } from './terminal/reporter'
import * as help from './commands/help'
import * as awsHelp from './commands/aws/help'
import * as deploymentHelp from './commands/aws/deployment/help'
import * as installationHelp from './commands/installation/help'
import type {
  AwsCommandOptions,
  AwsDeploymentCreateInput,
  AwsDeploymentCreateOptions,
  AwsDeploymentInput,
  AwsDeploymentOptions,
  AwsInput,
  InstallationConfigureInput,
  InstallationInput,
} from './input'
import type { CommanderError } from 'commander'
import type { DeploymentSelector } from './aws/deployment/volume/alias'
import type { ConfigureOptions } from './commands/installation/configure'
import type { InstallationSelector } from './installation/target/types'

export interface GlobalOptions {
  color: ColorMode
}

export interface ProgramHandlers {
  installation: {
    list(color: ColorMode): void | Promise<void>
    status(selector: InstallationSelector, color: ColorMode): void | Promise<void>
    inspect(selector: InstallationSelector, color: ColorMode): void | Promise<void>
    configure(selector: InstallationSelector, options: ConfigureOptions, color: ColorMode): void | Promise<void>
    reassign(selector: DeploymentSelector, color: ColorMode): void | Promise<void>
  }
  aws?: {
    connect(options: AwsCommandOptions, color: ColorMode): void | Promise<void>
    status(options: AwsCommandOptions, color: ColorMode): void | Promise<void>
    disconnect(options: AwsCommandOptions, color: ColorMode): void | Promise<void>
    deployment: {
      create(options: AwsDeploymentCreateOptions, color: ColorMode): void | Promise<void>
      status(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
      list(color: ColorMode): void | Promise<void>
      inspect(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
      verify(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
      prepare(options: AwsDeploymentOptions, color: ColorMode): void | Promise<void>
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

function addSelectorOptions(command: Command): void {
  addSingleOption(command, new Option('--id <deployment-id>', 'Select the deployment by the ID shown by list.'))
  addSingleOption(
    command,
    new Option('--alias <alias>', `Select the deployment by its local alias (default: ${AWS_SPEC.deployment.defaultName}).`),
  )
}

function addDeploymentOptions(command: Command): void {
  addSingleOption(command, new Option('--id <deployment-id>', 'Select the AWS deployment by its immutable ID.'))
  addSingleOption(command, new Option('--alias <alias>', 'Select the AWS deployment by its local alias.'))
}

function addTargetOptions(command: Command): void {
  addSingleOption(command, new Option('--local', 'Select the installation on this machine.'))
  addDeploymentOptions(command)
}

function addInstallOptions(command: Command): void {
  addSingleOption(command, new Option('--source <checkout>', 'Select the canonical Qiln Git checkout root on the target.'))
  addSingleOption(
    command,
    new Option('--image <alias-or-fingerprint>', 'Select an existing local image alias or full lowercase fingerprint.'),
  )
  addSingleOption(
    command,
    new Option('--image-meta <metadata>', 'Select the metadata artifact for explicit split-image replacement.'),
  )
  addSingleOption(
    command,
    new Option('--image-rootfs <rootfs>', 'Select the rootfs artifact for explicit split-image replacement.'),
  )
  addSingleOption(
    command,
    new Option('--authorized-keys <roster>', 'Select the developer-owned orchestrator SSH public-key roster.'),
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
  const installation = program
    .command('installation')
    .description('Inspect and configure the Qiln development installation on this machine or on a prepared AWS deployment.')
    .summary('Inspect and configure installations.')
  describeHelp(installation, installationHelp.group)
  const installationList = installation
    .command('list')
    .description('List every registered installation from retained local records, without contacting any target.')
    .summary('List local installation records.')
  describeHelp(installationList, installationHelp.list)
  installationList.action(() => handlers.installation.list(program.opts<GlobalOptions>().color))
  const installationStatus = installation
    .command('status')
    .description('Report the retained evidence of one installation without contacting its target or taking a lock.')
    .summary('Report local installation evidence.')
  addTargetOptions(installationStatus)
  describeHelp(installationStatus, installationHelp.status)
  installationStatus.action(() =>
    handlers.installation.status(
      convertInstallationSelector(installationStatus.opts<InstallationInput>()),
      program.opts<GlobalOptions>().color,
    ),
  )
  const installationInspect = installation
    .command('inspect')
    .description('Inspect the selected target, its Incus daemon, its storage and network, and any registered installation, without changes.')
    .summary('Inspect a target without changes.')
  addTargetOptions(installationInspect)
  describeHelp(installationInspect, installationHelp.inspect)
  installationInspect.action(() =>
    handlers.installation.inspect(
      convertInstallationSelector(installationInspect.opts<InstallationInput>()),
      program.opts<GlobalOptions>().color,
    ),
  )
  const installationConfigure = installation
    .command('configure')
    .description('Register if needed, then configure and verify the Qiln installation on the selected target, leaving the orchestrator stopped.')
    .summary('Configure the stopped installation.')
  addTargetOptions(installationConfigure)
  addInstallOptions(installationConfigure)
  describeHelp(installationConfigure, installationHelp.configure)
  installationConfigure.action(() => {
    const { selector, options } = convertInstallationConfigureOptions(
      installationConfigure.opts<InstallationConfigureInput>(),
    )
    return handlers.installation.configure(selector, options, program.opts<GlobalOptions>().color)
  })
  const installationReassign = installation
    .command('reassign')
    .description('Validate an existing installation against a replacement AWS deployment that holds its retained volume and, after approval, record that deployment as its current host.')
    .summary('Move the installation to a replacement host.')
  addDeploymentOptions(installationReassign)
  describeHelp(installationReassign, installationHelp.reassign)
  installationReassign.action(() =>
    handlers.installation.reassign(
      convertReassignSelector(installationReassign.opts<AwsDeploymentInput>()),
      program.opts<GlobalOptions>().color,
    ),
  )
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
    const verify = deployment
      .command('verify')
      .description('Retain the server host-key pin if needed, then run fixed read-only probes over the pinned SSH connection and report whether the guest meets the basic baseline.')
      .summary('Verify the basic guest baseline.')
    addSelectorOptions(verify)
    describeHelp(verify, deploymentHelp.verify)
    verify.action(() =>
      awsHandlers.deployment.verify(
        convertAwsDeploymentOptions(verify.opts<AwsDeploymentInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
    const prepare = deployment
      .command('prepare')
      .description('Retain the server host-key pin if needed, then read the host over the pinned SSH connection, display each preparation plan, and, after separate approval of each, apply it: first ZFS (the prerequisites, then one single-disk pool, created or imported by its recorded GUID, with its monthly scrub timer), then Incus (the repository, the exact packages, and one initialization on that pool).')
      .summary('Prepare ZFS and Incus after approval.')
    addSelectorOptions(prepare)
    describeHelp(prepare, deploymentHelp.prepare)
    prepare.action(() =>
      awsHandlers.deployment.prepare(
        convertAwsDeploymentOptions(prepare.opts<AwsDeploymentInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
    const ssh = deployment
      .command('ssh')
      .description('Reserved for an interactive administrative session. It is not available yet and stops with an explanation.')
      .summary('Unavailable: interactive administrative SSH.')
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
      .description('Approve and remove the removable recorded resources, then observe and retain their absence. Incus initialized by Qiln is stopped first, and a ZFS pool recorded as imported is exported, each under its own approval. Retained storage is not removed.')
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
