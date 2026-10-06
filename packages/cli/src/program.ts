import { Command, Option } from 'commander'
import { InstallerError } from './diagnostic/error'
import { AWS_SPEC } from './aws/spec'
import { convertAwsOptions, convertUpOptions, requireAwsName } from './input'
import { configureHelp } from './terminal/help'
import { Reporter, type ColorMode, type OutputStream } from './terminal/reporter'
import type { CommanderError } from 'commander'
import type { UpCommandOptions } from './commands/up'
import type { AwsCommandOptions, AwsInput, UpInput } from './input'

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

/**
 * Each invocation receives a fresh program so parsed values and duplicate
 * detection cannot leak into another execution.
 */
export function createProgram(handlers: ProgramHandlers, output: ProgramOutput): Command {
  const program = new Command()
  program
    .name('qiln')
    .description('Manage the Qiln development installation and AWS operator connections.')
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
  describeHelp(program, {
    examples: ['qiln doctor --help', 'qiln up --help', ...(handlers.aws ? ['qiln aws --help'] : [])],
    safety: [
      'Operational commands use only the unprivileged developer’s existing authority. Qiln never invokes sudo or another privilege-escalation mechanism.',
      'Review command-specific help for side effects and recovery boundaries.',
    ],
  })
  const doctor = program
    .command('doctor')
    .description(
      'Inspect the supported host, local Incus access, ZFS storage, networking, and existing installer state.',
    )
    .summary('Inspect the development host without changes.')
    .action(() => handlers.doctor(program.opts<GlobalOptions>().color))
  describeHelp(doctor, {
    examples: ['qiln doctor', 'qiln doctor --color never'],
    safety: [
      'Read-only inspection: Qiln does not change host, installer, or Incus state.',
      'Requires the supported Ubuntu host, preinstalled tools, local Incus access, and ZFS storage. Required host administration is performed manually.',
    ],
  })
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
  describeHelp(up, {
    examples: [
      'qiln up --source <checkout> --image <alias-or-fingerprint> --authorized-keys <roster>',
      'qiln up --source <checkout> --image <alias-or-fingerprint>',
      'qiln up --source <checkout> --image-meta <metadata> --image-rootfs <rootfs> [--authorized-keys <roster>]',
    ],
    safety: [
      '--image verifies an existing local alias or full lowercase SHA-256 fingerprint. It does not pull or replace an image.',
      '--image-meta with --image-rootfs explicitly authorizes deleting the image targeted by the managed qiln-orchestrator-dev alias before importing or reusing staged content. Other aliases on that image may be removed. No automatic rollback is attempted.',
      'The first credential set requires --authorized-keys. Later runs reuse retained credentials; a supplied roster replaces only authorized_keys.',
      'The selected image is trusted guest code. Qiln does not establish its provenance, authenticity, guest compatibility, or bootstrap readiness.',
      'The canonical host checkout is attached as a writable shifted source device. No source copying or service startup is performed. The configured orchestrator remains stopped.',
      'Run as an unprivileged developer. Persistent PostgreSQL data is preserved; incompatible retained resources require manual review.',
    ],
  })
  up.action(() => handlers.up(convertUpOptions(up.opts<UpInput>()), program.opts<GlobalOptions>().color))
  const awsHandlers = handlers.aws
  if (awsHandlers) {
    const aws = program
      .command('aws')
      .description('Manage Qiln-owned local AWS operator connections without provisioning infrastructure.')
      .summary('Manage local AWS operator connections.')
    describeHelp(aws, {
      examples: [
        'qiln aws connect --name default',
        'qiln aws status --name default',
        'qiln aws disconnect --name default',
      ],
      safety: [
        'AWS commands support unprivileged Linux and macOS operators, including Windows through WSL. They are independent of development doctor, Incus, Ubuntu-release, and ZFS checks.',
        'Connect an existing non-root IAM operator or explicitly approve root bootstrap to create one dedicated operator with console access, Sign-In permission, and scoped password/MFA self-service.',
        'Root authentication is accepted only in the separate bootstrap context. SSO, assumed-role onboarding, deployment permissions, and infrastructure provisioning are not available.',
      ],
    })
    const connect = aws
      .command('connect')
      .description(
        'Select a compatible AWS CLI and guide an existing operator login or explicitly approved new-account IAM bootstrap.',
      )
      .summary('Connect an existing operator or create one through approved bootstrap.')
    addSingleOption(
      connect,
      new Option('--name <name>', `Select a connection name (default: ${AWS_SPEC.defaultName}).`),
    )
    describeHelp(connect, {
      examples: ['qiln aws connect', 'qiln aws connect --name default'],
      safety: [
        `Without --name, connect uses '${AWS_SPEC.defaultName}'. New connections default to ${AWS_SPEC.defaultRegion} (Oregon). Reconnects suggest the saved region, then the pending region, before that fallback. The region remains editable.`,
        'Requires an interactive terminal. Qiln selects a compatible external AWS CLI first, then a validated ready managed CLI. Select the remote login flow when the browser is on another machine; copy its complete authorization code into the terminal when AWS prompts.',
        'Credentials refresh automatically while signed in. Login sessions last up to 12 hours; reconnect when AWS requires another login.',
        'Managed installation is available for Linux x64. macOS authentication requires a compatible external AWS CLI. The proposal shows the pinned version, target, exact artifact size, download host, destination, and installation effects. Installation approval is yes/no and defaults to no.',
        'Declining installation approval creates neither tool state nor connection state. Existing external AWS CLI installations are never updated, removed, repaired, or overwritten.',
        'Qiln uses already-installed prerequisites without privilege escalation, package-manager execution, global PATH changes, or shell-profile edits.',
        'Installation uses separate shared tool storage and locking, and must finish before connection-state access or authentication. Shared managed tools remain installed after disconnect.',
        'Unconfirmed setup termination retains potentially active inputs and the protective tool lock for manual recovery. Cleanup failures block authentication; installation effects are not automatically rolled back.',
        'Reconnecting replaces only the selected connections Qiln-owned local authentication cache. Identity verification is automatic; a recorded connection must match the same account, operator ARN, and immutable user ID before saving.',
        'Ordinary operator authentication rejects root, assumed-role, and SSO identities. Existing-operator connections remain identity-only and do not change IAM configuration or assess password replacement, MFA, or deployment access.',
        'New-account setup uses a separate root authentication directory. The account, observed root MFA configuration, complete policy documents, and intended IAM changes are shown before explicit approval.',
        'Bootstrap creates one tagged IAM user, attaches the reviewed SignInLocalDevelopmentAccess policy, adds scoped password/MFA self-service, and creates one initial console password requiring replacement. It creates no permanent access keys or blanket administrator/deployment permissions.',
        'The initial password is generated and displayed only by an isolated terminal process. It is not sent through IPC, stored in journals, recovered, redisplayed, or reissued.',
        'The operator must complete browser password replacement; operator MFA enrollment is optional. Explicit rechecks inspect readiness; an omitted password-reset field is unknown, not successful completion.',
        'Root authentication is terminated and removed before the ordinary connection is saved. A completed bootstrap journal is retained and must match the saved operator during ordinary commands.',
        'Incomplete or failed bootstrap does not automatically resume, adopt users, repair permissions, delete IAM resources, or replay mutations. A timeout or exhausted propagation check does not prove that a mutation failed.',
        'No compute, networking, storage, or deployed Qiln services are provisioned.',
        'Deployment access is not assessed; completed bootstrap requires password replacement, not operator MFA enrollment.',
      ],
    })
    connect.action(() =>
      awsHandlers.connect(convertAwsOptions(connect.opts<AwsInput>()), program.opts<GlobalOptions>().color),
    )
    const status = aws
      .command('status')
      .description('Verify saved AWS operator identities against their recorded account, ARN, and immutable user ID.')
      .summary('Verify saved connections; credentials may refresh.')
    addSingleOption(status, new Option('--name <name>', 'Inspect one connection; otherwise inspect all.'))
    describeHelp(status, {
      examples: ['qiln aws status', 'qiln aws status --name default'],
      safety: [
        'This command never downloads or installs AWS CLI tools.',
        'Verification may refresh temporary credentials and update the local authentication cache. This is not a read-only cache inspection.',
        'Credentials refresh automatically while signed in. Login sessions last up to 12 hours; reconnect when AWS requires another login.',
        'Root authentication is refused and its local authentication cache is removed when detected.',
        'A completed bootstrap journal must match its saved operator. Incomplete, failed, or inconsistent bootstrap records block ordinary verification and expose recovery facts.',
        'Deployment access, password-reset completion, and MFA configuration are not assessed. No infrastructure is provisioned.',
      ],
    })
    status.action(() =>
      awsHandlers.status(convertAwsOptions(status.opts<AwsInput>()), program.opts<GlobalOptions>().color),
    )
    const disconnect = aws
      .command('disconnect')
      .description('Remove one Qiln-owned local AWS connection and authentication cache after confirmation.')
      .summary('Remove a local connection after confirmation.')
    addSingleOption(disconnect, new Option('--name <name>', 'Select the local connection to remove.'))
    describeHelp(disconnect, {
      examples: ['qiln aws disconnect --name default'],
      safety: [
        'Requires an explicit connection name and interactive confirmation.',
        'Only the selected Qiln-owned local connection, authentication caches, and explicitly disclosed bootstrap journal are removed. Shared managed tools remain installed; IAM identities and infrastructure are not deleted. This command never downloads or installs tools.',
        'Incomplete-bootstrap removal discloses retained or potentially created IAM resources and requires confirmed authentication termination. Unsafe or inconsistent local state is not removed automatically.',
        'Removing a bootstrap journal removes its local ownership and recovery evidence. Inspect or retain that evidence before approving local removal.',
        'Local removal is not immediate credential revocation. Credentials already loaded elsewhere can remain usable until expiration.',
      ],
    })
    disconnect.action(() => {
      const options = convertAwsOptions(disconnect.opts<AwsInput>())
      requireAwsName(options)
      return awsHandlers.disconnect(options, program.opts<GlobalOptions>().color)
    })
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
