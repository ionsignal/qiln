import { Command, Option } from 'commander'
import { InstallerError } from './diagnostic/error'
import { AWS_SPEC } from './aws/spec'
import { convertAwsOptions, convertUpOptions } from './input'
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
      examples: ['qiln aws connect', 'qiln aws disconnect', 'qiln aws status'],
      safety: [
        'AWS commands support unprivileged Linux and macOS operators, including Windows through WSL. They are independent of development doctor, Incus, Ubuntu-release, and ZFS checks.',
        'Connect an existing non-root IAM operator or explicitly approve root bootstrap to create one dedicated operator with console access, Sign-In permission, scoped password/MFA self-service, and a separate regional foundation policy.',
        'A saved Qiln-created operator can receive a new root-approved permission-only review. Its immutable identity, password, MFA enrollment, creation identity, and saved ordinary operator login are preserved. Unsupported local layouts are not adopted or migrated.',
        'Root authentication is accepted only in separate approved bootstrap contexts. SSO, assumed-role onboarding, EC2 foundation inspection, and infrastructure provisioning are not available.',
      ],
    })
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
    describeHelp(connect, {
      examples: ['qiln aws connect', 'qiln aws connect --name default'],
      safety: [
        `Without --name, connect uses '${AWS_SPEC.defaultName}'. The selected connection is inspected before account setup or CLI selection. Saved connections proceed with IAM-user sign-in; retained pending IAM operations require explicit recovery before reconnecting.`,
        `New connections default to ${AWS_SPEC.defaultRegion} (Oregon). Reconnects suggest the saved region before that fallback. The region remains editable.`,
        'For a new connection, choose an existing IAM user or create a dedicated IAM user for Qiln. Creating a user requires root sign-in and explicit approval of the displayed IAM setup summary. Neither choice deploys infrastructure.',
        'Requires an interactive terminal. Qiln selects a compatible external AWS CLI first, then a validated ready managed CLI. Select the remote login flow when the browser is on another machine; copy its complete authorization code into the terminal when AWS prompts.',
        'Credentials refresh automatically while signed in. Login sessions last up to 12 hours; reconnect when AWS requires another login.',
        'Managed installation is available for Linux x64. macOS authentication requires a compatible external AWS CLI. The proposal shows the pinned version, target, exact artifact size, download host, destination, and installation effects. Installation approval is yes/no and defaults to no.',
        'Declining installation approval creates neither tool state nor connection state. Existing external AWS CLI installations are never updated, removed, repaired, or overwritten.',
        'Qiln uses already-installed prerequisites without privilege escalation, package-manager execution, global PATH changes, or shell-profile edits.',
        'Installation uses separate shared tool storage and locking, and must finish before connection-state access or authentication. Shared managed tools remain installed after disconnect.',
        'Unconfirmed setup termination retains potentially active inputs and the protective tool lock for manual recovery. Cleanup failures block authentication; installation effects are not automatically rolled back.',
        'Reconnecting replaces only the selected connection’s Qiln-owned local authentication cache. Identity verification is automatic; a recorded connection must match the same account, operator ARN, and immutable user ID before saving.',
        'Ordinary operator authentication rejects root, assumed-role, and SSO identities. Arbitrary existing IAM users are authenticated without IAM modification. Saved Qiln-created operators may separately approve permission-only bootstrap after authentication is saved.',
        'New operator setup uses a separate root authentication directory. The account, intended operator, foundation region, observed root MFA configuration, and IAM setup summary are shown before one yes/no approval that defaults to no. Onboarding does not require typing the account ID.',
        'New bootstrap creates one tagged IAM user, attaches the reviewed SignInLocalDevelopmentAccess policy, adds unchanged scoped password/MFA self-service, creates and attaches the current customer-managed foundation policy, and creates one initial console password requiring replacement. Intent and returned evidence are persisted for the outstanding mutation before its verification; verified mutations are replaced by the next intent, not accumulated as a history.',
        'Onboarding and permission maintenance show one concise completion row per IAM mutation after retained results, successful AWS verification, and persisted verification evidence. No paired working row, animated spinner, or raw provider output is used. Failed or uncertain steps are described by recovery diagnostics.',
        'Foundation authority is approved for one displayed region independently of the editable connection default. Changing that default neither changes IAM permissions nor automatically triggers regional permission expansion.',
        'Permission-only bootstrap preserves the existing user ID, ARN, password, MFA devices, creation identity, Sign-In policy, password/MFA self-service, and saved operator login. Its approval summary distinguishes creating and attaching a missing dedicated foundation policy, creating a new default version for whole-document replacement while retaining existing versions, and verifying matching live content without IAM changes or version creation.',
        'Maintenance approval discloses regional networking, constrained On-Demand launches, encrypted EBS, Elastic IPs, administrative public-key import, and instance/console inspection. It does not approve infrastructure provisioning or spending; exact deployment inputs require a separately approved immutable intent. Completion distinguishes freshly verified changes from freshly verified no-change.',
        'Unexpected policy identities, attachments, groups, permanent access keys, or operation evidence stop reconciliation. Bound policy content is observed for review; changed approved preconditions stop execution. Existing unattached policies are not adopted to recover partial execution.',
        'The operator foundation policy grants no IAM administration, iam:PassRole, SSM, NAT-gateway, load-balancer, or resource-removal authority. No general-purpose ec2:* grant is used.',
        'The foundation policy is customer-managed, not inline. Its completed document is checked against the 6,144-character limit. A required replacement with five inspected retained versions stops before approval or mutation intent; execution independently rechecks approved preconditions and capacity. Five versions do not block matching-content no-change verification. Policy versions are retained without automatic pruning, older-default selection, or rollback.',
        'The initial password is generated and displayed only by an isolated terminal process. The copy instruction appears immediately above its heading. The password is not sent through IPC, stored in pending evidence, recovered, redisplayed, or reissued.',
        'After the password and browser instructions are shown, Qiln proceeds into AWS login without an operator-name confirmation. The operator must complete browser password replacement; operator MFA enrollment is optional. Readiness facts appear together before explanatory information and actions. Identity verification and explicit readiness rechecks remain required; an omitted password-reset field is unknown, not successful completion.',
        'New-onboarding root authentication is terminated and removed before the ordinary connection is saved. Permission-only bootstrap starts after ordinary authentication is saved and removes only its separate root subtree. Declining or failing permission bootstrap does not remove the saved operator cache.',
        'Incomplete or failed creation and permission operations retain minimal pending approval and recovery evidence. They are not automatically resumed, adopted, repaired, rolled back, or replayed. A timeout or exhausted propagation check does not prove that a mutation failed. Unconfirmed credential-process termination retains potentially active inputs and the protective connection lock.',
        'IAM inspection does not atomically exclude another administrator. Stop concurrent IAM changes; observed inconsistencies block execution.',
        'No infrastructure or deployed Qiln services are provisioned.',
        'Completed pending evidence is removed after publication. Saved bindings and last-verified permission metadata describe the verified configuration, not current IAM correctness or safe launch inputs. Completed new onboarding requires password replacement, not operator MFA enrollment.',
        'Read-only EC2 foundation inspection is deferred. No AZ, AMI, GPU offering, local administrative key, public-IP observation, quota, capacity, host compatibility, or deployment readiness is established.',
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
        'Pending operations with unconfirmed root-context termination block ordinary verification. Other validated pending evidence is reported separately when a saved operator connection exists; it does not establish current IAM correctness.',
        'Permission evidence is reported as saved bindings and last-verified metadata without freshly inspecting IAM. The editable default region is independent of recorded foundation scope.',
        'Password-reset completion, MFA configuration, EC2 discovery, launch capacity, and deployment readiness are not assessed. No infrastructure is provisioned.',
      ],
    })
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
    describeHelp(disconnect, {
      examples: ['qiln aws disconnect', 'qiln aws disconnect --name default'],
      safety: [
        `Without --name, disconnect selects '${AWS_SPEC.defaultName}'. If that connection is absent, nothing is removed; another connection is never selected implicitly.`,
        'Displays the selected connection and its known account and IAM-user identity. Removal requires interactive yes/no approval and defaults to no.',
        'Only the selected Qiln-owned local connection, authentication caches, and disclosed pending IAM evidence are removed. Shared managed tools remain installed; IAM identities, policies, policy versions, and infrastructure are not deleted. This command never downloads or installs tools.',
        'Incomplete IAM-operation removal discloses retained or potentially created resources and requires confirmed recorded root-context termination. Unsafe or inconsistent local state is not removed automatically.',
        'Removing the connection and pending evidence discards local ownership bindings, approval, and recovery evidence. Inspect or retain that evidence before approving local removal.',
        'Local removal is not immediate credential revocation. Credentials already loaded elsewhere can remain usable until expiration.',
      ],
    })
    disconnect.action(() =>
      awsHandlers.disconnect(convertAwsOptions(disconnect.opts<AwsInput>()), program.opts<GlobalOptions>().color),
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
