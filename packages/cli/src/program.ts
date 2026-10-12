import { Command, Option } from 'commander'
import { InstallerError } from './diagnostic/error'
import { AWS_SPEC } from './aws/spec'
import {
  convertAwsDeploymentCreateOptions,
  convertAwsDeploymentOptions,
  convertAwsOptions,
  convertUpOptions,
} from './input'
import { configureHelp } from './terminal/help'
import { Reporter, type ColorMode, type OutputStream } from './terminal/reporter'
import type { CommanderError } from 'commander'
import type { UpCommandOptions } from './commands/up'
import type {
  AwsCommandOptions,
  AwsDeploymentCreateInput,
  AwsDeploymentCreateOptions,
  AwsDeploymentInput,
  AwsDeploymentOptions,
  AwsInput,
  UpInput,
} from './input'

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
  addSingleOption(command, new Option('--id <deployment-id>', 'Select the deployment by the ID printed by create.'))
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
      'Manage the Qiln development installation, AWS operator connections, and approved AWS network deployments.',
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
      .description('Manage Qiln-owned local AWS operator connections and explicitly approved network deployments.')
      .summary('Manage AWS connections and network deployments.')
    describeHelp(aws, {
      examples: ['qiln aws connect', 'qiln aws disconnect', 'qiln aws status', 'qiln aws deployment --help'],
      safety: [
        'AWS commands support unprivileged Linux and macOS operators, including Windows through WSL. They are independent of development doctor, Incus, Ubuntu-release, and ZFS checks.',
        'Connect an existing non-root IAM operator or explicitly approve root bootstrap to create one dedicated operator with console access, Sign-In permission, scoped password/MFA self-service, and a separate regional foundation policy.',
        'A saved Qiln-created operator can receive a new root-approved permission-only review. Its immutable identity, password, MFA enrollment, creation identity, and saved ordinary operator login are preserved. Unsupported local layouts are not adopted or migrated.',
        'Root authentication is accepted only in separate approved bootstrap contexts. SSO, assumed-role onboarding, and EC2 foundation inspection are not available. Connecting never provisions or removes infrastructure; provisioning requires separate approval.',
        'The deployment group creates and removes one approved network per deployment, each with its own approval. See qiln aws deployment --help.',
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
        'Maintenance approval discloses regional networking, creation and deletion of Qiln-tagged VPCs, subnets, internet gateways, route tables, and security groups, constrained On-Demand launches, encrypted EBS, Elastic IPs, administrative public-key import, and instance/console inspection. VPC deletion authority covers any VPC in the bound account and region tagged with this operator’s ARN, qiln:managed-by=qiln-cli, and a nonempty qiln:deployment value, not only one deployment ID. Deletion authority for subnets, internet gateways, route tables, and security groups covers any such resource in the bound account and region tagged with this operator’s ARN. It does not approve infrastructure provisioning or spending, and connect itself never provisions or removes anything; exact deployment inputs require a separately approved immutable intent. Completion distinguishes freshly verified changes from freshly verified no-change.',
        'Unexpected policy identities, attachments, groups, permanent access keys, or operation evidence stop reconciliation. Bound policy content is observed for review; changed approved preconditions stop execution. Existing unattached policies are not adopted to recover partial execution.',
        'The operator foundation policy grants no IAM administration, iam:PassRole, SSM, NAT-gateway, load-balancer, or removal authority other than deleting VPCs, subnets, internet gateways, route tables, and security groups tagged for this operator. No general-purpose ec2:* grant is used.',
        'The foundation policy is customer-managed, not inline. Its completed document is checked against the 6,144-character limit. A required replacement with five inspected retained versions stops before approval or mutation intent; execution independently rechecks approved preconditions and capacity. Five versions do not block matching-content no-change verification. Policy versions are retained without automatic pruning, older-default selection, or rollback.',
        'The initial password is generated and displayed only by an isolated terminal process. The copy instruction appears immediately above its heading. The password is not sent through IPC, stored in pending evidence, recovered, redisplayed, or reissued.',
        'After the password and browser instructions are shown, Qiln proceeds into AWS login without an operator-name confirmation. The operator must complete browser password replacement; operator MFA enrollment is optional. Readiness facts appear together before explanatory information and actions. Identity verification and explicit readiness rechecks remain required; an omitted password-reset field is unknown, not successful completion.',
        'New-onboarding root authentication is terminated and removed before the ordinary connection is saved. Permission-only bootstrap starts after ordinary authentication is saved and removes only its separate root subtree. Declining or failing permission bootstrap does not remove the saved operator cache.',
        'Incomplete or failed creation and permission operations retain minimal pending approval and recovery evidence. They are not automatically resumed, adopted, repaired, rolled back, or replayed. A timeout or exhausted propagation check does not prove that a mutation failed. Unconfirmed credential-process termination retains potentially active inputs and the protective connection lock.',
        'IAM inspection does not atomically exclude another administrator. Stop concurrent IAM changes; observed inconsistencies block execution.',
        'No infrastructure or deployed Qiln services are provisioned.',
        'Completed pending evidence is removed after publication. Saved bindings and last-verified permission metadata describe the verified configuration, not current IAM correctness or safe launch inputs. Completed new onboarding requires password replacement, not operator MFA enrollment.',
        'Read-only EC2 foundation inspection is deferred. No AZ, AMI, GPU offering, local administrative key, public-IP observation, quota, capacity, host compatibility, or deployment readiness is established.',
        'Connect is refused while any deployment records unconfirmed child termination; see qiln aws deployment --help.',
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
        'Verification is refused while any deployment records unconfirmed child termination.',
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
    const deployment = aws
      .command('deployment')
      .description('Create, inspect, and remove one explicitly approved AWS network bound to a Qiln-managed operator.')
      .summary('Manage approved network deployments.')
    describeHelp(deployment, {
      examples: [
        'qiln aws deployment create',
        'qiln aws deployment list',
        'qiln aws deployment status --alias <alias>',
        'qiln aws deployment inspect --id <deployment-id>',
        'qiln aws deployment remove --alias <alias>',
      ],
      safety: [
        'Each deployment is one fixed IPv4 network: a VPC, one /24 subnet per standard Availability Zone, an internet gateway, a route table that sends 0.0.0.0/0 to the gateway, and one host security group. Instances, Elastic IPs, NAT, IPv6, load balancers, storage, remote preparation, pricing, and quota discovery are not available. This lifecycle exercises approval, evidence, locking, and recovery; it does not demonstrate spend protection.',
        'Create and remove each require a separate interactive yes/no approval that defaults to no. Later commands resolve the connection and every binding from the deployment record; there are no resource-ID, region, tag, CIDR, or rebinding options.',
        `Each deployment has a unique local alias (default: ${AWS_SPEC.deployment.defaultName}), displayed as qiln-<alias> beside its immutable ID. status, inspect, and remove select by --alias or --id, never both; with neither they select the default alias. An alias is local metadata only: it is not an AWS tag and never changes a resource name. Deployment records are never deleted, so an alias is not reused after removal, and a second create needs a new --alias. Selecting a deployment never bypasses the fresh observation and approval that removal requires.`,
        'Provider work runs as one fenced call per step, each followed by a bounded observation of the recorded network. Deployment commands hold the exclusive AWS-operation lock, which is retained when child termination is unconfirmed. Connect, status, and the deployment commands that authenticate are refused while any deployment records unconfirmed child termination. Recovery is forward-only: Qiln does not replay uncertain mutations, adopt resources, or resume abandoned work.',
        'A mutating call that failed before it was sent is recorded as not attempted. A failure during or after sending, and any transport failure, stays uncertain.',
        'Deployment records are retained across disconnect, which refuses while effects remain outstanding. Qiln never deletes AWS resources or deployment evidence automatically. Completion does not establish public reachability, working HTTPS or SSH, launch authority, capacity, Ubuntu compatibility, readiness, or rollback.',
      ],
    })
    const create = deployment
      .command('create')
      .description('Approve and create the fixed network in the pinned private CIDR, then verify each step by observation.')
      .summary('Create one approved network.')
    addSingleOption(
      create,
      new Option('--name <name>', `Select the connection (default: ${AWS_SPEC.defaultName}).`),
    )
    addSingleOption(
      create,
      new Option(
        '--alias <alias>',
        `Name the new deployment with a unique local alias (default: ${AWS_SPEC.deployment.defaultName}).`,
      ),
    )
    describeHelp(create, {
      examples: [
        'qiln aws deployment create',
        'qiln aws deployment create --name default',
        'qiln aws deployment create --alias staging',
      ],
      safety: [
        `Without --name, create uses '${AWS_SPEC.defaultName}'. The connection must be a Qiln-created operator whose recorded permission verification matches the current requirement; otherwise run qiln aws connect for a root-approved review. Arbitrary existing IAM users remain authentication-only.`,
        `Without --alias, create uses '${AWS_SPEC.deployment.defaultName}'. The alias must be unused by every retained deployment record, including removed ones, and is checked before authentication and again when the approval is saved. It is local metadata only.`,
        `Besides the optional alias, the only input is the administrator IPv4 network allowed to reach SSH, prompted interactively. It must be canonical with no host bits and not /0. Ports 80 and 443 are open to the internet. The VPC CIDR is pinned by this Qiln release (${AWS_SPEC.deployment.defaultCidr}) and copied into the approval; the record alone governs later commands, and a later release never retargets an existing deployment.`,
        'Placement uses the standard Availability Zones visible in the permission region, at most six, all of which must be available. Qiln never skips or chooses among zones. Zones are frozen at approval, and zones added later never join an existing deployment.',
        'The account, operator, region, CIDRs, zones, ingress rules, default tenancy, ownership tags, and AWS default VPC components are displayed before one yes/no approval that defaults to no. The approval is persisted before any provider call.',
        'Each creation call has no idempotency token and never resumes. An uncertain outcome is never repeated; clean up a stopped creation with remove, and a new create is a new deployment. Every returned identity is retained before its verification.',
        'Each step is verified by observing the recorded resources until they match the retained evidence, including owner, CIDR, zone, tags, routes, associations, and security group rules. The AWS-created main route table, default security group, network ACL, and DHCP association are not touched or observed. Requires an interactive terminal and the saved operator login.',
      ],
    })
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
    describeHelp(deploymentStatus, {
      examples: ['qiln aws deployment status --alias <alias>', 'qiln aws deployment status --id <deployment-id>'],
      safety: [
        'Reads local deployment evidence only. No credentials are used and no AWS call is made, so it also works while another AWS operation holds the lock.',
        'The reported outcome is derived from retained facts. It does not establish the current state of AWS resources; use inspect for a fresh observation.',
      ],
    })
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
    describeHelp(list, {
      examples: ['qiln aws deployment list'],
      safety: [
        'Reads local deployment evidence only. No credentials are used, no AWS call is made, and no lock is required, so it also works while another AWS operation holds the lock.',
        'Recorded states and outstanding-effects flags are derived from retained facts. They do not establish the current state of AWS resources; use inspect for a fresh observation.',
        'An unreadable or incompatible record fails the whole listing instead of being skipped.',
      ],
    })
    list.action(() => awsHandlers.deployment.list(program.opts<GlobalOptions>().color))
    const inspect = deployment
      .command('inspect')
      .description('Authenticate as the recorded operator, observe the recorded network, and retain the observation.')
      .summary('Retain a fresh network observation.')
    addSelectorOptions(inspect)
    describeHelp(inspect, {
      examples: ['qiln aws deployment inspect --alias <alias>', 'qiln aws deployment inspect --id <deployment-id>'],
      safety: [
        'Authenticates as the recorded operator and makes read-only EC2 calls. Like aws status, it may refresh temporary credentials.',
        'With retained resource identities it observes the recorded network once. Without one it lists VPCs carrying the recorded operator and deployment tags for display only: candidates are never adopted, and an empty listing proves nothing.',
        'An observation that agrees with the retained evidence also verifies a step whose response was retained but not yet verified. Inspecting never makes a mutating call.',
        'Absence never proves who deleted a resource. Inspection is refused while an earlier child process remains unconfirmed.',
      ],
    })
    inspect.action(() =>
      awsHandlers.deployment.inspect(
        convertAwsDeploymentOptions(inspect.opts<AwsDeploymentInput>()),
        program.opts<GlobalOptions>().color,
      ),
    )
    const remove = deployment
      .command('remove')
      .description('Approve and remove the recorded network resources, then observe and retain their absence.')
      .summary('Remove one approved network.')
    addSelectorOptions(remove)
    describeHelp(remove, {
      examples: ['qiln aws deployment remove --alias <alias>', 'qiln aws deployment remove --id <deployment-id>'],
      safety: [
        'Selecting a deployment by alias or ID grants nothing: removal still needs retained resource identities, confirmed prior child termination, an unspent refusal budget (at most three definitely refused removal steps), and no earlier step that is unresolved or uncertain. Only a definite earlier refusal permits another attempt; verified deletions never spend the budget.',
        'A fresh observation must match the recorded network; otherwise removal is refused and no deletion call is made, including after partial external deletion. If every recorded resource is observed absent, no call is made either.',
        'After a separate yes/no approval that defaults to no, deletions run serially in dependency order, each one call followed by an observation. The run stops at the first refused or uncertain step; completed deletions are preserved, and another invocation needs a fresh observation and approval.',
        'AWS refusal because dependent resources remain is the only dependency gate; Qiln never removes dependents it did not record. Absence is observed and retained after each deletion.',
        'Removal uses the permission evidence recorded with the deployment and never forces a root permission review. It is not rolled back once attempted.',
      ],
    })
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
