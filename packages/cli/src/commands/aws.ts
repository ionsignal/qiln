import { randomUUID } from 'node:crypto'
import { InstallerError, type DiagnosticFact } from '../diagnostic/error'
import * as connections from '../aws/connections'
import { bootstrapRecovery, diagnostic, recovery, terminationConfirmed } from '../aws/errors'
import { Bootstrap } from '../aws/bootstrap'
import * as bootstrapState from '../aws/bootstrap/state'
import { ready, type Proposal, type Readiness } from '../aws/bootstrap/types'
import { requireAuthentication, requireIdentity } from '../aws/auth/identity'
import * as awsLogin from '../aws/auth/login'
import * as tools from '../aws/tools'
import { removeAuth, Session } from '../aws/auth/session'
import { AWS_SPEC } from '../aws/spec'
import { requireAwsHost, userId, withAwsState } from '../aws/state'
import type { AwsAuthentication, AwsIdentity, AwsOperation, LoginFlow } from '../aws/types'
import { requireAwsName, validateAwsRegion, type AwsCommandOptions } from '../input'
import { openChildDir, type Dir } from '../state/files'
import { checkCancellation, Prompts, withCancellation } from '../terminal/prompts'
import type { Reporter } from '../terminal/reporter'

function reportAuthentication(reporter: Reporter, authentication: AwsAuthentication): void {
  reporter.row('verified', 'AWS account', authentication.identity.accountId)
  reporter.row('verified', 'Operator', authentication.identity.arn)
  reporter.row('verified', 'User identity', authentication.identity.userId)
  reporter.row('verified', 'Authentication', 'signed in · credentials refresh automatically')
}

async function fail(directory: Dir, operation: AwsOperation, error: unknown): Promise<never> {
  const failure = diagnostic(error)
  const termination = terminationConfirmed(error)
  let cleanup = false
  if (termination) {
    try {
      await removeAuth(directory)
      cleanup = true
    } catch {
      cleanup = false
    }
  }
  let journal = true
  try {
    await connections.journal(directory, {
      ...operation,
      phase: 'failed',
    })
  } catch {
    journal = false
  }
  throw recovery(failure, { termination, cleanup, journal }, `qiln aws connect --name ${operation.name}`)
}

function progress(reporter: Reporter): (event: tools.Progress) => void {
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
        reporter.info('Installing AWS CLI into the approved Qiln-managed destination.')
        return
      case 'installation-verified':
        reporter.row('verified', 'Installation', 'managed payload and exact CLI version verified')
        return
      case 'ready':
        reporter.row('verified', 'Managed tool', 'ready · installation transaction and tool-lock handling completed')
        return
    }
  }
}

async function selectCli(reporter: Reporter, prompts: Prompts, signal: AbortSignal): Promise<awsLogin.AwsCli> {
  reporter.section('AWS CLI')
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
      'AWS CLI',
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
  reporter.info(
    'Optional installation: Qiln downloads this pinned AWS CLI into shared tool storage. Existing external or global AWS CLI installations remain untouched.',
  )
  for (const effect of proposal.effects) {
    reporter.info(effect)
  }
  reporter.info(
    'Uses installed prerequisites only; no package manager, privilege escalation, global PATH changes, or shell-profile edits.',
  )
  reporter.info(
    'Authentication starts only after installation, workspace cleanup, and tool-lock handling complete. Managed tools remain installed after disconnect.',
  )
  reporter.notice(
    'Installation effects are not automatically rolled back. Unconfirmed setup termination retains potentially active inputs and the protective lock for manual recovery.',
  )
  await prompts.approve('Install the displayed Qiln-managed AWS CLI')
  checkCancellation(signal)
  const cli = await tools.install(proposal, {
    signal,
    progress: progress(reporter),
  })
  checkCancellation(signal)
  reporter.row('verified', 'AWS CLI', `Qiln-managed ${cli.version} · ${cli.executable}`)
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

async function continueSetup(prompts: Prompts, label: string): Promise<void> {
  const selected = await prompts.select(label, [
    'I completed the browser steps; recheck now',
    'Cancel setup and remove its local authentication contexts',
  ])
  if (selected !== 0) {
    throw new InstallerError({
      code: 'COMMAND_CANCELLED',
    })
  }
}

function showDocument(reporter: Reporter, label: string, document: string): void {
  const parsed: unknown = JSON.parse(document)
  const formatted = JSON.stringify(parsed, null, 2)
  if (typeof formatted !== 'string') {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_STATE_INVALID',
    })
  }
  reporter.section(label)
  reporter.help(`${reporter.fragment(formatted)}\n`)
}

function reportProposal(reporter: Reporter, proposal: Proposal): void {
  reporter.section('IAM review')
  reporter.row('verified', 'AWS account', proposal.accountId)
  reporter.row('verified', 'Operator name', proposal.operatorName)
  reporter.row('verified', 'Operator ARN', proposal.operatorArn)
  reporter.row('verified', 'Operation', proposal.operationId)
  reporter.row('verified', 'Managed policy', proposal.managedPolicyArn)
  reporter.row('verified', 'Policy version', proposal.managedPolicy.versionId)
  reporter.row('verified', 'Policy SHA-256', proposal.managedPolicy.sha256)
  reporter.row('verified', 'Inline policy', proposal.inlinePolicyName)
  for (const mutation of proposal.mutations) {
    reporter.info(mutation)
  }
  reporter.notice(
    'The AWS-managed attachment follows its default policy version. Qiln reviews it before attachment and during readiness, but cannot permanently pin AWS-controlled permissions.',
  )
  reporter.info(
    'Permissions are limited to browser sign-in and scoped password/MFA self-service; no blanket administrator or infrastructure deployment access.',
  )
  reporter.notice(
    'IAM changes are external side effects. Failure or cancellation does not delete the operator, undo permissions, or reissue its initial password.',
  )
  reporter.info(`Optional virtual MFA device names: ${proposal.mfaDeviceNames.join(' or ')}.`)
  showDocument(reporter, 'Reviewed managed policy document', proposal.managedPolicy.document)
  showDocument(reporter, 'Operator self-service policy document', proposal.inlinePolicy)
}

function reportReadiness(reporter: Reporter, readiness: Readiness): void {
  reporter.section('Operator readiness')
  if (readiness.passwordResetRequired === false) {
    reporter.row('verified', 'Password', 'replacement requirement cleared')
  } else {
    reporter.action('Replace the initial operator password in the AWS browser, then recheck.')
  }
  if (readiness.mfaDevices > 0) {
    reporter.row('verified', 'Operator MFA', `${readiness.mfaDevices} configured device(s)`)
    reporter.info('MFA enrollment is optional. Configured devices do not prove that this session used MFA.')
  } else {
    reporter.info('MFA enrollment is optional; no devices are currently configured.')
  }
  reporter.row('verified', 'Access keys', `${readiness.accessKeys} permanent access keys`)
}

async function authenticate(session: Session, expected: AwsIdentity, signal: AbortSignal): Promise<AwsAuthentication> {
  const authentication = await session.verify(signal)
  requireAuthentication(authentication, expected)
  return authentication
}

async function connectOperator(
  directory: Dir,
  name: string,
  cli: awsLogin.AwsCli,
  prompts: Prompts,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<void> {
  const previous = await connections.read(directory, name)
  const pending = await connections.operation(directory, name)
  await bootstrapState.requireConnection(directory, previous)
  if (pending?.phase === 'disconnecting') {
    throw new InstallerError({
      code: 'AWS_DISCONNECT_INCOMPLETE',
      facts: [['Connection', name]],
      retry: `qiln aws disconnect --name ${name}`,
    })
  }
  const expected = connections.binding(previous, pending)
  reporter.section('Operator sign-in')
  if (previous || pending) {
    reporter.info(
      previous
        ? `Refreshing sign-in for connection '${name}' and replacing its local authentication cache. Authentication must match its recorded operator.`
        : `An earlier attempt is recorded for connection '${name}'. Qiln will replace its local authentication context and require a fresh login.`,
    )
    if (expected) {
      reporter.row('verified', 'Recorded account', expected.accountId)
      reporter.row('verified', 'Recorded operator', expected.arn)
    }
  }
  const region = validateAwsRegion(
    await prompts.text('Default AWS region', previous?.region ?? pending?.region ?? AWS_SPEC.defaultRegion),
  )
  const flow = await selectFlow(prompts)
  let operation: AwsOperation = {
    version: 1,
    id: randomUUID(),
    name,
    region,
    phase: 'login',
    identity: expected,
    startedAt: new Date().toISOString(),
  }
  checkCancellation(signal)
  await connections.journal(directory, operation)
  try {
    await removeAuth(directory)
    const session = await Session.create(directory, region)
    reporter.action('Sign in as the intended IAM operator. Root, assumed-role, and SSO identities are not accepted.')
    reportLogin(reporter, flow)
    await awsLogin.login(cli, session, flow, signal)
    reporter.section('Verifying operator')
    const authentication = await session.verify(signal)
    if (expected) {
      requireIdentity(authentication.identity, expected)
    }
    operation = {
      ...operation,
      phase: 'verified',
      identity: authentication.identity,
    }
    await connections.journal(directory, operation)
    checkCancellation(signal)
    const finalAuthentication = await session.verify(signal)
    requireIdentity(finalAuthentication.identity, authentication.identity)
    if (expected) {
      requireIdentity(finalAuthentication.identity, expected)
    }
    checkCancellation(signal)
    reportAuthentication(reporter, finalAuthentication)
    await connections.save(directory, {
      version: 1,
      name,
      region,
      identity: finalAuthentication.identity,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      cliVersion: cli.version,
      sdkVersion: AWS_SPEC.sdkVersion,
    })
    await connections.journal(directory, {
      ...operation,
      phase: 'saved',
    })
  } catch (error: unknown) {
    await fail(directory, operation, error)
  }
}

async function connectAccount(
  directory: Dir,
  name: string,
  cli: awsLogin.AwsCli,
  prompts: Prompts,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<void> {
  const recorded = await bootstrapState.read(directory)
  if (recorded) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_RECORDED',
      facts: bootstrapState.facts(recorded),
      retry: `qiln aws disconnect --name ${name}`,
    })
  }
  if ((await directory.list()).length !== 0) {
    throw new InstallerError({
      code: 'AWS_BOOTSTRAP_CONFLICT',
      facts: [
        [
          'Connection',
          'New-account setup requires an empty local connection entry. Use the existing-operator flow for a saved connection.',
        ],
      ],
      retry: 'qiln aws connect',
    })
  }
  reporter.section('Root sign-in')
  const region = validateAwsRegion(await prompts.text('Default AWS region', AWS_SPEC.defaultRegion))
  const flow = await selectFlow(prompts)
  let bootstrap: Bootstrap | undefined
  let operation: AwsOperation | undefined
  let operatorStarted = false
  try {
    checkCancellation(signal)
    bootstrap = await Bootstrap.create(directory, name, region)
    reporter.action('Sign in as the intended AWS account root user.')
    reporter.info('This separate root context is used only for the approved IAM setup and readiness checks.')
    reporter.info(
      'Root and operator credentials stay in separate CLI-owned authentication directories. Neither is delivered to Qiln services or capsule branches.',
    )
    reportLogin(reporter, flow)
    await bootstrap.login(cli, flow, signal)
    reporter.section('Verifying root')
    await bootstrap.inspect(signal)
    reporter.info('Root MFA inspection checks configuration, not whether this session authenticated with MFA.')
    while (true) {
      const root = bootstrap.record.root
      if (!root) {
        throw new InstallerError({
          code: 'AWS_BOOTSTRAP_STATE_INVALID',
        })
      }
      reporter.row('verified', 'Root account', root.identity.accountId)
      reporter.row('verified', 'Root identity', root.identity.arn)
      if (root.mfaConfigured) {
        reporter.row('verified', 'Root MFA', 'configured')
        break
      }
      reporter.action(
        'Enroll root MFA in the AWS browser, then recheck. Qiln will not change root MFA or create the operator before enrollment is observed.',
      )
      await continueSetup(prompts, 'Root MFA enrollment')
      checkCancellation(signal)
      await bootstrap.inspect(signal)
    }
    const proposal = bootstrap.proposal()
    reportProposal(reporter, proposal)
    await prompts.confirm('Approve these IAM changes for the displayed account', proposal.accountId)
    await bootstrap.approve(proposal, signal)
    reporter.info('Creating the dedicated operator.')
    reporter.action('Copy the initial password when it appears. It is shown once and is not retained by Qiln.')
    await bootstrap.createOperator(signal)
    const operator = bootstrap.record.operator
    if (!operator) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_STATE_INVALID',
      })
    }
    reporter.section('Operator sign-in')
    reporter.row('verified', 'AWS account', operator.accountId)
    reporter.row('verified', 'Operator name', proposal.operatorName)
    reporter.row('verified', 'Operator ARN', operator.arn)
    reporter.row('verified', 'User identity', operator.userId)
    reporter.action(`Open the AWS console and sign in as ${proposal.operatorName}:`)
    reporter.line(`https://${operator.accountId}.signin.aws.amazon.com/console/`)
    reporter.info('Use a separate browser session or sign out of root first.')
    reporter.action(
      'Replace the initial password in the browser before continuing. Operator MFA enrollment is optional.',
    )
    reporter.info(
      `For optional virtual MFA, use ${proposal.operatorName} or a device name beginning ${proposal.operatorName}-.`,
    )
    await prompts.confirm(
      'When ready to authenticate as the operator, continue with its user name',
      proposal.operatorName,
    )
    checkCancellation(signal)
    operation = {
      version: 1,
      id: randomUUID(),
      name,
      region,
      phase: 'login',
      identity: operator,
      startedAt: new Date().toISOString(),
    }
    await connections.journal(directory, operation)
    operatorStarted = true
    const session = await Session.create(directory, region)
    reporter.action('For the next AWS login, select the created operator, not the root browser session.')
    reportLogin(reporter, flow)
    await awsLogin.login(cli, session, flow, signal)
    reporter.section('Verifying operator')
    let authentication = await authenticate(session, operator, signal)
    operation = {
      ...operation,
      phase: 'verified',
    }
    await connections.journal(directory, operation)
    let readiness = await bootstrap.verify(authentication, signal)
    reportReadiness(reporter, readiness)
    while (!ready(readiness)) {
      await continueSetup(prompts, 'Operator password replacement')
      checkCancellation(signal)
      authentication = await authenticate(session, operator, signal)
      readiness = await bootstrap.verify(authentication, signal)
      reportReadiness(reporter, readiness)
    }
    checkCancellation(signal)
    const finalAuthentication = await authenticate(session, operator, signal)
    const finalReadiness = await bootstrap.verify(finalAuthentication, signal)
    if (!ready(finalReadiness)) {
      throw new InstallerError({
        code: 'AWS_BOOTSTRAP_CONFLICT',
        facts: [
          [
            'Observed',
            'Operator readiness changed during final verification. No completed connection should be inferred.',
          ],
        ],
      })
    }
    requireAuthentication(finalAuthentication, operator)
    checkCancellation(signal)
    await bootstrap.clean()
    reporter.row(
      'verified',
      'Root context',
      'authentication processes terminated and local bootstrap authentication removed',
    )
    requireAuthentication(finalAuthentication, operator)
    checkCancellation(signal)
    reportAuthentication(reporter, finalAuthentication)
    await connections.save(directory, {
      version: 1,
      name,
      region,
      identity: finalAuthentication.identity,
      createdAt: new Date().toISOString(),
      cliVersion: cli.version,
      sdkVersion: AWS_SPEC.sdkVersion,
    })
    await connections.journal(directory, {
      ...operation,
      phase: 'saved',
    })
    await bootstrap.complete()
  } catch (error: unknown) {
    if (!bootstrap) {
      throw error
    }
    const termination = terminationConfirmed(error)
    let cleanup = !operatorStarted
    if (operatorStarted && termination) {
      try {
        await removeAuth(directory)
        cleanup = true
      } catch {
        cleanup = false
      }
    }
    let journal = true
    if (operation) {
      try {
        await connections.journal(directory, {
          ...operation,
          phase: 'failed',
        })
      } catch {
        journal = false
      }
    }
    let persisted = 'not confirmed; inspect the retained local record'
    try {
      const connection = await connections.read(directory, name)
      persisted = connection
        ? `present for ${connection.identity.arn}; it was not rolled back and does not establish completed onboarding`
        : 'absent when inspected; IAM changes were not rolled back'
    } catch {
      persisted = 'not confirmed; inspect the retained local record'
    }
    const facts: readonly DiagnosticFact[] = [
      ['Operator authentication cleanup', operatorStarted ? (cleanup ? 'completed' : 'not confirmed') : 'not required'],
      ['Operator failure journal', operation ? (journal ? 'persisted' : 'persistence not confirmed') : 'not required'],
      ['Connection record', persisted],
    ]
    await bootstrap.fail(error, { cleanup, journal }, facts)
  }
}

export async function connect(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  let newAccount = false
  await withCancellation(async signal => {
    const prompts = new Prompts(signal, reporter)
    const setup = await prompts.select('Account setup:', [
      'Connect an existing non-root IAM operator',
      'Create a dedicated operator using approved root bootstrap',
    ])
    newAccount = setup === 1
    const cli = await selectCli(reporter, prompts, signal)
    const name = requireAwsName({
      name: options.name ?? AWS_SPEC.defaultName,
    })
    reporter.info(`Connection: ${name}.`)
    checkCancellation(signal)
    await withAwsState(true, async store => {
      const directory = await connections.open(store, name, true)
      if (newAccount) {
        await connectAccount(directory, name, cli, prompts, signal, reporter)
      } else {
        await connectOperator(directory, name, cli, prompts, signal, reporter)
      }
    })
  })
  reporter.section('Completion')
  if (newAccount) {
    reporter.info(
      'The operator has console access, reviewed Sign-In permission, and scoped password/MFA self-service. MFA enrollment is optional; no permanent access keys or infrastructure deployment permissions were created.',
    )
    reporter.info(
      'Root authentication was removed before saving the connection. The completed bootstrap journal is retained.',
    )
  } else {
    reporter.info(
      'IAM configuration was unchanged. Password replacement, MFA, and deployment access were not assessed.',
    )
  }
  reporter.info('No infrastructure or deployed Qiln services were provisioned.')
  reporter.summary(
    newAccount
      ? 'AWS account connected. Operator onboarding completed.'
      : 'AWS account connected. Non-root operator verified.',
  )
}

export async function status(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  await withCancellation(async signal => {
    return await withAwsState(false, async store => {
      const names = options.name === undefined ? await connections.names(store) : [options.name]
      if (names.length === 0) {
        reporter.summary('No Qiln AWS connections are saved.')
      }
      for (const name of names) {
        checkCancellation(signal)
        const directory = await connections.open(store, name)
        const connection = await connections.read(directory, name)
        const operation = await connections.operation(directory, name)
        connections.binding(connection, operation)
        await bootstrapState.requireConnection(directory, connection)
        reporter.section(name)
        if (operation && operation.phase !== 'saved') {
          reporter.notice(
            `Recorded operation phase: ${operation.phase}. Inspect or resume this connection before relying on it.`,
          )
        }
        if (!connection) {
          throw new InstallerError({
            code: 'AWS_CONNECTION_INCOMPLETE',
            facts: [['Connection', name]],
            retry: `qiln aws connect --name ${name}`,
          })
        }
        if (operation?.phase === 'disconnecting') {
          throw new InstallerError({
            code: 'AWS_DISCONNECT_INCOMPLETE',
            facts: [['Connection', name]],
            retry: `qiln aws disconnect --name ${name}`,
          })
        }
        const session = await Session.open(directory, connection.region)
        let authentication: AwsAuthentication
        try {
          authentication = await session.verify(signal)
          requireIdentity(authentication.identity, connection.identity)
        } catch (error: unknown) {
          if (error instanceof InstallerError && error.code === 'AWS_ROOT_REFUSED') {
            await fail(
              directory,
              {
                version: 1,
                id: randomUUID(),
                name,
                region: connection.region,
                phase: 'failed',
                identity: connection.identity,
                startedAt: new Date().toISOString(),
              },
              error,
            )
          }
          throw error
        }
        reportAuthentication(reporter, authentication)
        reporter.row('verified', 'Default region', connection.region)
      }
    })
  })
}

export async function disconnect(options: AwsCommandOptions, reporter: Reporter): Promise<void> {
  requireAwsHost()
  const name = requireAwsName(options)
  await withCancellation(async signal => {
    const prompts = new Prompts(signal, reporter)
    await withAwsState(false, async store => {
      const directory = await connections.open(store, name)
      const connection = await connections.read(directory, name)
      const pending = await connections.operation(directory, name)
      const bootstrap = await bootstrapState.read(directory)
      let identity = connections.binding(connection, pending)
      if (bootstrap) {
        if (bootstrap.termination !== 'confirmed') {
          throw bootstrapRecovery(
            new InstallerError({
              code: 'AWS_BOOTSTRAP_RECORDED',
            }),
            {
              termination: false,
              cleanup: false,
              journal: true,
            },
            bootstrapState.facts(bootstrap),
          )
        }
        if (bootstrap.phase === 'saved' && bootstrap.failureCode === null) {
          await bootstrapState.requireConnection(directory, connection)
        }
        if (bootstrap.operator && identity) {
          requireIdentity(identity, bootstrap.operator)
        }
        identity ??= bootstrap.operator
        reporter.section('Retained IAM resources')
        for (const [label, value] of bootstrapState.facts(bootstrap)) {
          reporter.info(`${label}: ${value}`)
        }
        reporter.notice(
          'Local removal does not delete the IAM operator, login profile, policies, or MFA devices. Partial resources may exist even when creation was not verified.',
        )
        reporter.notice(
          'Removing the bootstrap journal removes its local ownership and recovery evidence. Inspect or retain that evidence before approving removal.',
        )
      }
      reporter.info(
        'Disconnect removes only this Qiln-owned local connection, authentication caches, and any disclosed bootstrap journal. Shared managed tools, IAM identities, and infrastructure remain.',
      )
      reporter.notice('Credentials already loaded elsewhere can remain usable until expiration.')
      await prompts.confirm(
        bootstrap ? 'Remove the local connection and disclosed bootstrap records' : 'Remove the local AWS connection',
        name,
      )
      checkCancellation(signal)
      await connections.journal(directory, {
        version: 1,
        id: randomUUID(),
        name,
        region: connection?.region ?? pending?.region ?? bootstrap?.region ?? AWS_SPEC.defaultRegion,
        phase: 'disconnecting',
        identity,
        startedAt: new Date().toISOString(),
      })
      try {
        await removeAuth(directory)
        if (bootstrap) {
          const bootstrapDirectory = await openChildDir(directory, AWS_SPEC.state.bootstrap, {
            owner: userId(),
            mode: 0o700,
          })
          await removeAuth(bootstrapDirectory)
        }
        await connections.remove(store, name)
      } catch (error: unknown) {
        const failure = diagnostic(error)
        throw new InstallerError({
          code: failure.code,
          facts: [
            ...failure.facts,
            ...(bootstrap ? bootstrapState.facts(bootstrap) : []),
            [
              'Local removal',
              'Removal or synchronization was not confirmed. Inspect the remaining local records; no IAM deletion was attempted.',
            ],
          ],
          retry: `qiln aws disconnect --name ${name}`,
        })
      }
    })
  })
  reporter.summary(
    `Local AWS connection '${name}' removed. Shared tools retained; no IAM identities or infrastructure deleted.`,
  )
}
