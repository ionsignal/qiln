import { AWS_RECORD_VERSION, AWS_SPEC } from '../../aws/spec'
import { InstallerError } from '../../diagnostic/error'
import { terminationConfirmed } from '../../aws/recovery'
import { Bootstrap } from '../../aws/iam/bootstrap'
import { canonical } from '../../json'
import { operatorName } from '../../aws/operator'
import { ready, type MutationProgress, type Proposal, type Readiness } from '../../aws/iam/types'
import { POLICY_KEYS } from '../../aws/permission/keys'
import { currentRequirement, reviewRequired } from '../../aws/permission/spec'
import { requireIdentity } from '../../aws/auth/identity'
import { removeAuth, Session } from '../../aws/auth/session'
import { openExistingConnections } from '../../aws/root'
import { requireAwsHost } from '../../aws/host'
import { resolveAwsName, validateAwsRegion, type AwsCommandOptions } from '../../input'
import { checkCancellation, Prompts, withCancellation } from '../../terminal/prompts'
import { modesOf, policyLabel, reportPermissionChange } from './review'
import { withConfirmedOperation } from '../../aws/operation'
import { authenticate, failAuthentication, reportAuthentication, requireAvailable } from './shared'
import * as awsLogin from '../../aws/auth/login'
import * as tools from '../../aws/tools'
import * as connections from '../../aws/connection/records'
import type { Dir } from '../../state/files'
import type { Reporter } from '../../terminal/reporter'
import type { AwsAuthentication, AwsConnection, LoginFlow } from '../../aws/types'

type PermissionOutcome = 'not-applicable' | 'recorded' | 'declined' | 'changed' | 'unchanged'

async function inspectConnection(name: string, reporter: Reporter): Promise<boolean> {
  const store = await openExistingConnections()
  if (!store || !(await connections.names(store)).includes(name)) {
    return false
  }
  const directory = await connections.open(store, name)
  await requireAvailable(directory)
  const saved = await connections.read(directory, name)
  if (!saved) {
    return false
  }
  reporter.row('verified', 'Recorded account', saved.identity.accountId)
  reporter.row('verified', 'Recorded IAM user', saved.identity.arn)
  reporter.row('verified', 'Recorded user ID', saved.identity.userId)
  reporter.space()
  reporter.info(
    `Connection '${name}' is saved. Sign in as its recorded IAM user; no operator will be recreated.`,
  )
  return true
}

function toolProgress(reporter: Reporter): (event: tools.Progress) => void {
  let lastUpdate = 0
  return event => {
    switch (event.stage) {
      case 'downloading': {
        const now = Date.now()
        if (event.received === 0 || event.received === event.total || now - lastUpdate >= 5_000) {
          lastUpdate = now
          reporter.info(`Downloading AWS CLI: ${event.received} / ${event.total} bytes.`)
        }
        return
      }
      case 'artifact-verified':
        reporter.row('verified', 'Artifact', 'downloaded byte count and SHA-256 match the pinned release')
        return
      case 'installing':
        return
      case 'installation-verified':
        reporter.row('verified', 'Installation', 'Installed managed payload and exact CLI version verified')
        return
      case 'ready':
        reporter.row('verified', 'Managed tool', 'installation transaction and tool-lock handling completed')
        return
    }
  }
}

function iamProgress(reporter: Reporter): (event: MutationProgress) => void {
  const steps: Record<MutationProgress['action'], { label: string; detail: string }> = {
    'create-user': {
      label: 'Operator',
      detail: 'created',
    },
    'attach-signin': {
      label: 'Sign-In policy',
      detail: 'attached',
    },
    'grant-self': {
      label: 'Self-service',
      detail: 'configured',
    },
    'create-policy': {
      label: 'Policy',
      detail: 'created',
    },
    'attach-policy': {
      label: 'Policy',
      detail: 'attached',
    },
    'replace-policy': {
      label: 'Policy',
      detail: 'new default version created',
    },
    password: {
      label: 'Initial password',
      detail: 'terminal write completed · login profile verified',
    },
  }
  return event => {
    if (event.phase !== 'verified') {
      return
    }
    const step = steps[event.action]
    reporter.row('verified', event.key === null ? step.label : policyLabel(event.key), step.detail)
  }
}

async function selectCli(reporter: Reporter, prompts: Prompts, signal: AbortSignal): Promise<awsLogin.AwsCli> {
  reporter.section('AWS Tools')
  const selection = await tools.resolve(signal)
  checkCancellation(signal)
  if (selection.rejected) {
    reporter.notice(
      selection.rejected.reason === 'incompatible'
        ? `The external AWS CLI reports ${selection.rejected.version ?? 'an unrecognized version'}; ${AWS_SPEC.cliVersion} is required. It will not be used or modified.`
        : 'The external AWS CLI could not be inspected successfully. It will not be used or modified.',
    )
  }
  if (selection.kind !== 'proposal') {
    reporter.row(
      'verified',
      'CLI',
      `${selection.kind === 'external' ? 'external' : 'Qiln-managed'} ${selection.cli.version} · ${selection.cli.executable}`,
    )
    return selection.cli
  }
  const proposal = selection.proposal
  reporter.row('verified', 'CLI policy', proposal.version)
  reporter.row('verified', 'Target', proposal.target)
  reporter.row('verified', 'Artifact size', `${proposal.artifact.bytes} bytes`)
  reporter.row('verified', 'Download host', new URL(proposal.artifact.url).hostname)
  reporter.row('verified', 'Destination', proposal.destination)
  reporter.space()
  for (const effect of proposal.effects) {
    reporter.info(effect)
  }
  reporter.info(
    'Existing external and global installations remain untouched. No package manager, privilege escalation, global PATH changes, or shell-profile edits are performed.',
  )
  reporter.info(
    'Authentication starts only after installation, workspace cleanup, and tool-lock handling complete. Managed tools remain installed after disconnect.',
  )
  reporter.space()
  reporter.notice(
    'Installation effects are not automatically rolled back. Unconfirmed setup termination retains potentially active inputs and the protective lock.',
  )
  await prompts.approve('Install the displayed Qiln-managed AWS CLI')
  reporter.space()
  checkCancellation(signal)
  const cli = await tools.install(proposal, {
    signal,
    progress: toolProgress(reporter),
  })
  checkCancellation(signal)
  reporter.row('verified', 'AWS CLI', `Qiln-managed awscli@${cli.version} installed to ${cli.executable}`)
  return cli
}

async function selectFlow(prompts: Prompts): Promise<LoginFlow> {
  const selected = await prompts.select('Authentication flow', [
    'Browser on this machine',
    'Remote terminal: open the AWS-provided link on another machine',
  ])
  return selected === 0 ? 'browser' : 'remote'
}

function reportLogin(reporter: Reporter, flow: LoginFlow): void {
  reporter.section('Browser sign-in')
  reporter.info(
    flow === 'remote'
      ? '1. Open the AWS link below in your browser on another machine.'
      : '1. Continue in the browser AWS opens, or open the AWS link displayed below.',
  )
  reporter.info('2. Sign in as the AWS identity requested above.')
  if (flow === 'remote') {
    reporter.info('3. Copy the complete authorization code shown in the browser.')
    reporter.info('4. Paste it into this terminal when AWS prompts, then press Enter.')
  } else {
    reporter.info('3. Return to this terminal when browser sign-in is complete.')
  }
  reporter.help('\n')
}

async function recheck(prompts: Prompts, label: string): Promise<void> {
  const selected = await prompts.select(label, [
    'I completed the browser steps; recheck now',
    'Cancel setup',
  ])
  if (selected !== 0) {
    throw new InstallerError({
      code: 'COMMAND_CANCELLED',
    })
  }
}

function reportSetup(reporter: Reporter, proposal: Proposal): void {
  reporter.section('AWS operator setup')
  reporter.info(
    'Create a dedicated operator with browser sign-in and the customer-managed EC2 policies displayed below.',
  )
  reporter.space()
  reporter.line('- Initial password shown once; replacement required.')
  reporter.line('- Operator MFA optional. No permanent access keys.')
  reporter.line('- No IAM administration. Connect does not create or remove infrastructure.')
  reportPermissionChange(reporter, proposal)
}

function reportDeclined(reporter: Reporter): void {
  reporter.space()
  reporter.info(
    'Policy update declined. The saved operator login is retained; current IAM configuration is not claimed.',
  )
}

async function inspectRoot(
  bootstrap: Bootstrap,
  cli: awsLogin.AwsCli,
  flow: LoginFlow,
  prompts: Prompts,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<void> {
  reportLogin(reporter, flow)
  await bootstrap.login(cli, flow, signal)
  let inspection = await bootstrap.inspect(signal)
  reporter.section('Root review')
  while (!inspection.root.mfaConfigured) {
    reporter.row('verified', 'Root account', inspection.root.identity.accountId)
    reporter.action('Enroll root MFA in the AWS browser, then recheck. No IAM mutation is permitted before approval.')
    await recheck(prompts, 'Root MFA enrollment')
    checkCancellation(signal)
    inspection = await bootstrap.inspect(signal)
  }
  reporter.row('verified', 'Root MFA', 'configured')
}

async function maintain(
  directory: Dir,
  saved: AwsConnection,
  cli: awsLogin.AwsCli,
  prompts: Prompts,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<PermissionOutcome> {
  reporter.section('Permission review')
  const requirement = currentRequirement(saved)
  if (!requirement) {
    reporter.info('This connection is authentication-only. No Qiln-managed IAM ownership is inferred from its name.')
    return 'not-applicable'
  }
  if (!reviewRequired(saved)) {
    reporter.row(
      'verified',
      'Metadata',
      'Recorded metadata matches current requirements; live IAM was not freshly inspected.',
    )
    return 'recorded'
  }
  reporter.notice(
    'The required AWS policies are not verified for this operator. Authentication success is not permission compliance. Continuing signs in as root to review the exact change; IAM is not modified until you approve the displayed changes, which are not automatically undone.',
  )
  if (!(await prompts.consent('Sign in as root to review required AWS policy changes now'))) {
    reportDeclined(reporter)
    return 'declined'
  }
  checkCancellation(signal)
  const flow = await selectFlow(prompts)
  const bootstrap = await Bootstrap.maintain(directory, saved)
  let policiesChanged = false
  try {
    reporter.section('Root sign-in')
    reporter.info('This separate root context does not replace or remove the saved ordinary operator login.')
    reporter.space()
    reporter.action(`Sign in as the root user of recorded AWS account ${saved.identity.accountId}.`)
    await inspectRoot(bootstrap, cli, flow, prompts, signal, reporter)
    const proposal = bootstrap.proposal()
    const modes = modesOf(proposal)
    policiesChanged = POLICY_KEYS.some(key => modes[key] !== 'none')
    reportPermissionChange(reporter, proposal)
    if (policiesChanged && !(await prompts.consent('Apply the displayed IAM policy changes'))) {
      await bootstrap.decline()
      reporter.row('verified', 'Root context', 'processes terminated and local authentication removed')
      reportDeclined(reporter)
      return 'declined'
    }
    await bootstrap.approve(proposal, signal)
    reporter.section('IAM update')
    await bootstrap.apply(signal, iamProgress(reporter))
    await bootstrap.complete()
  } catch (error: unknown) {
    return await bootstrap.fail(error)
  }
  reporter.row(
    'verified',
    'IAM configuration',
    policiesChanged
      ? 'approved policy changes freshly verified'
      : 'matching live policy configuration freshly verified; no IAM changes or version creation',
  )
  reporter.row('verified', 'Root context', 'processes terminated and local authentication removed')
  reporter.row('verified', 'Saved operator login', 'retained')
  return policiesChanged ? 'changed' : 'unchanged'
}

function reportReadiness(reporter: Reporter, readiness: Readiness): void {
  const passwordReplaced = readiness.passwordResetRequired === false
  reporter.section('Operator readiness')
  reporter.row(
    passwordReplaced ? 'verified' : 'working',
    'Password',
    passwordReplaced ? 'replacement requirement cleared' : 'replacement not confirmed',
  )
  reporter.row('verified', 'Operator MFA', `${readiness.mfaDevices} configured device(s) · optional`)
  reporter.row('verified', 'Access keys', `${readiness.accessKeys} permanent access keys`)
  if (!passwordReplaced) {
    reporter.action('Replace the initial operator password in the AWS browser, then recheck.')
  }
}

async function connectOperator(
  directory: Dir,
  name: string,
  cli: awsLogin.AwsCli,
  prompts: Prompts,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<AwsConnection> {
  await requireAvailable(directory)
  const saved = await connections.read(directory, name)
  const region = validateAwsRegion(
    await prompts.text('Default AWS region', saved?.region ?? AWS_SPEC.defaultRegion),
  )
  const flow = await selectFlow(prompts)
  checkCancellation(signal)
  try {
    await removeAuth(directory)
    const session = await Session.create(directory, region)
    reporter.space()
    reporter.action('Sign in as the intended IAM user. Root, assumed-role, and SSO identities are not accepted.')
    reportLogin(reporter, flow)
    await awsLogin.login(cli, session, flow, signal)
    reporter.section('Verifying operator')
    const authentication = await session.verify(signal)
    if (saved) {
      requireIdentity(authentication.identity, saved.identity)
    }
    checkCancellation(signal)
    const connection: AwsConnection = {
      name,
      region,
      version: AWS_RECORD_VERSION.connection,
      identity: authentication.identity,
      createdAt: saved?.createdAt ?? new Date().toISOString(),
      managed: saved?.managed ?? null,
    }
    await connections.save(directory, connection)
    const persisted = await connections.read(directory, name)
    if (canonical(persisted) !== canonical(connection)) {
      throw new InstallerError({
        code: 'AWS_STATE_INVALID',
      })
    }
    reportAuthentication(reporter, authentication)
    return connection
  } catch (error: unknown) {
    return await failAuthentication(directory, name, error)
  }
}

async function onboard(
  directory: Dir,
  name: string,
  cli: awsLogin.AwsCli,
  prompts: Prompts,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<void> {
  await requireAvailable(directory)
  if ((await directory.list()).length !== 0) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_CONFLICT',
      facts: [['Connection', 'Initial onboarding requires an empty current-layout connection directory.']],
    })
  }
  const region = validateAwsRegion(
    await prompts.text('Deployment region (fixed for this connection; also the initial default login region)', AWS_SPEC.defaultRegion),
  )
  const flow = await selectFlow(prompts)
  const bootstrap = await Bootstrap.onboard(directory, name, region)
  let operatorStarted = false
  let finalAuthentication: AwsAuthentication | undefined
  try {
    reporter.section('Root sign-in')
    reporter.action('Sign in as the intended AWS account root user.')
    reporter.info(
      'Root and operator credentials remain in separate local directories. Neither is delivered to hosts, Qiln services, or capsule branches.',
    )
    await inspectRoot(bootstrap, cli, flow, prompts, signal, reporter)
    const proposal = bootstrap.proposal()
    reportSetup(reporter, proposal)
    await prompts.approve('Approve this AWS operator setup')
    await bootstrap.approve(proposal, signal)
    reporter.section('IAM setup')
    await bootstrap.createOperator(signal, iamProgress(reporter))
    const operator = bootstrap.record.operator
    if (!operator) {
      throw new InstallerError({
        code: 'AWS_PERMISSION_STATE_INVALID',
      })
    }
    const userName = operatorName(name)
    reporter.section('Operator sign-in')
    reporter.row('verified', 'Operator ARN', operator.arn)
    reporter.row('verified', 'User identity', operator.userId)
    reporter.info('Use a separate browser session or sign out of root first.')
    reporter.action(`Open the AWS console and sign in as ${userName}:`)
    reporter.line(`https://${operator.accountId}.signin.aws.amazon.com/console/`)
    reporter.action('Replace the initial password before continuing. Operator MFA enrollment is optional.')
    reporter.info(`Optional virtual MFA names: ${userName} or a name beginning ${userName}-.`)
    checkCancellation(signal)
    operatorStarted = true
    const session = await Session.create(directory, region)
    reporter.action('For this AWS login, select the created operator, not the root browser session.')
    reportLogin(reporter, flow)
    await awsLogin.login(cli, session, flow, signal)
    let authentication = await authenticate(session, operator, signal)
    let readiness = await bootstrap.readiness(authentication, signal)
    reportReadiness(reporter, readiness)
    while (!ready(readiness)) {
      await recheck(prompts, 'Operator password replacement')
      checkCancellation(signal)
      authentication = await authenticate(session, operator, signal)
      readiness = await bootstrap.readiness(authentication, signal)
      reportReadiness(reporter, readiness)
    }
    finalAuthentication = await authenticate(session, operator, signal)
    await bootstrap.verify(finalAuthentication, signal)
    checkCancellation(signal)
    await bootstrap.complete(finalAuthentication)
  } catch (error: unknown) {
    let cleanup = !operatorStarted
    if (operatorStarted && terminationConfirmed(error)) {
      try {
        await removeAuth(directory)
        cleanup = true
      } catch {
        cleanup = false
      }
    }
    let inspected = true
    let bindingFact = 'not inspected'
    try {
      const saved = await connections.read(directory, name)
      bindingFact = saved
        ? `retained for ${saved.identity.arn}; no binding or IAM rollback was attempted`
        : 'absent when inspected; partial IAM resources may remain'
    } catch {
      inspected = false
      bindingFact = 'persistence or inspection not confirmed'
    }
    return await bootstrap.fail(
      error,
      [
        ['Operator authentication cleanup', operatorStarted ? (cleanup ? 'completed' : 'not confirmed') : 'not required'],
        ['Connection binding', bindingFact],
      ],
      {
        cleanup,
        journal: inspected,
      },
    )
  }
  if (finalAuthentication) {
    reportAuthentication(reporter, finalAuthentication)
  }
  reporter.row('verified', 'IAM configuration', 'current approved operator configuration freshly verified')
  reporter.row('verified', 'Root context', 'processes terminated and local authentication removed before publication')
}

export async function connect(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const name = resolveAwsName(options)
  let createOperator = false
  const outcome = await withCancellation(async signal => {
    const prompts = new Prompts(signal, 'qiln aws connect', reporter)
    reporter.section('AWS connection')
    reporter.row('verified', 'Connection', name)
    const saved = await inspectConnection(name, reporter)
    checkCancellation(signal)
    if (!saved) {
      const choice = await prompts.select('How would you like to sign in?', [
        'Sign in with an existing IAM user',
        'Create a dedicated IAM user for Qiln',
      ])
      createOperator = choice === 1
    }
    const cli = await selectCli(reporter, prompts, signal)
    checkCancellation(signal)
    return await withConfirmedOperation(true, async ({ connections: store }) => {
      const directory = await connections.open(store, name, true)
      await requireAvailable(directory)
      if (createOperator) {
        await onboard(directory, name, cli, prompts, signal, reporter)
        return 'completed' as const
      }
      const connection = await connectOperator(directory, name, cli, prompts, signal, reporter)
      return await maintain(directory, connection, cli, prompts, signal, reporter)
    })
  })
  reporter.space()
  switch (outcome) {
    case 'completed':
      reporter.info('Operator onboarding and the current approved IAM configuration were verified.')
      break
    case 'changed':
      reporter.info('Policy update completed with verified changes.')
      break
    case 'unchanged':
      reporter.info('Policy update freshly verified matching live policy configuration without IAM changes or policy version creation.')
      break
    case 'declined':
      reporter.info('Authentication is saved. Policy update was declined; current live IAM configuration is not claimed.')
      break
    case 'recorded':
      reporter.info('Authentication is saved. Matching last-verified metadata is retained; live IAM was not freshly inspected.')
      break
    case 'not-applicable':
      reporter.info('The existing IAM user remains an authentication-only connection. IAM configuration was not modified.')
      break
  }
  reporter.info(
    'IAM verification does not establish every effective permission under account restrictions, EC2 capacity, SSH access, or deployment readiness.',
  )
  reporter.info('No EC2 discovery, infrastructure provisioning, or deployed Qiln services were performed.')
  reporter.summary(createOperator ? 'Operator onboarding completed.' : 'AWS operator authentication saved.')
}
