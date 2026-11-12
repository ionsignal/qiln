import { z } from 'zod'
import { START_STEPS } from './steps'
import { stepSink, type StepResult } from './progress'
import { openInBrowser } from '../browser'
import { InstallerError } from '../../diagnostic/error'
import { isStopped } from '../../installation/instance'
import { Starter } from '../../installation/startup/starter'
import { actionsOf, type Admin, type StartupAction, type StartupPlan } from '../../installation/startup/types'
import { reportApproval, stepsOf } from '../../terminal/approval'
import { isInteractive, type Prompts } from '../../terminal/prompts'
import type { Observation } from '../../installation/observe'
import type { Retry } from '../../installation/retry'
import type { Dir } from '../../state/files'
import type { Reporter } from '../../terminal/reporter'
import type { IncusClient } from '../../transport/incus/client'

export interface StartContext {
  directory: Dir
  name: string
  client: IncusClient
  retry: Retry
  prompts: Prompts
  reporter: Reporter
  signal: AbortSignal
  observation: Observation
}

export type StartState = 'running' | 'stopped'

const MINIMUM_PASSWORD_LENGTH = 12
const PROBE_TIMEOUT_MS = 10_000
const email = z.email()

const UNIT = 'unit exited zero · completion only, not application correctness'

const RESULTS: Record<StartupAction, StepResult> = {
  'start-instance': { outcome: 'verified', detail: 'running · guest prerequisites active' },
  install: { outcome: 'verified', detail: UNIT },
  build: { outcome: 'verified', detail: UNIT },
  migrate: { outcome: 'verified', detail: UNIT },
  grant: { outcome: 'verified', detail: UNIT },
  'create-admin': { outcome: 'created', detail: `${UNIT} · administrator created or already present` },
  'start-services': { outcome: 'verified', detail: 'services active · /health answered inside the guest' },
}

const DETAILS: Partial<Record<StartupAction, string>> = {
  install: 'npm ci with lifecycle scripts and network access; replaces node_modules in the checkout',
  build: 'writes packages/*/dist, ssh/dist, and app/dist in the writable checkout',
  migrate: 'changes the persistent PostgreSQL volume; applied migrations are never rolled back',
  grant: 'applies the SSH role privileges in one transaction',
  'create-admin': 'prompted next, pushed as a one-shot protected file, and removed when the script reads it',
  'start-services': 'started, not enabled',
}

function reportStart(reporter: Reporter, plan: StartupPlan): void {
  reportApproval(reporter, {
    title: 'Proposed orchestrator startup',
    steps: stepsOf(actionsOf(plan), START_STEPS, DETAILS),
    covers:
      'Each guest step runs through root exec over the Incus socket, which is already root-equivalent authority, as a transient systemd unit named qiln-startup that runs as the qiln user. Step output stays in the guest journal (journalctl -u qiln-startup).',
    stays:
      'Services are started, not enabled, so they do not start again when the orchestrator restarts. No cloud firewall port is opened, and nothing outside the orchestrator and its checkout changes.',
    lasting:
      'The checkout is written with guest-built dependencies, and on a local target it is your own working copy. Database changes and the administrator persist and are not rolled back. A failed or interrupted step is never replayed, and it blocks later startups until startup.json in the installation directory is removed by hand.',
    notEstablished:
      'Application correctness: a unit that exits zero shows completion only. Public reachability, DNS, and certificate trust are not established either.',
  })
}

async function prompted(
  prompts: Prompts,
  reporter: Reporter,
  label: string,
  valid: (value: string) => boolean,
  rule: string,
  secret = false,
): Promise<string> {
  while (true) {
    const value = secret ? await prompts.secret(label) : await prompts.text(label)
    if (valid(value)) {
      return value
    }
    reporter.info(rule)
  }
}

async function askAdmin(prompts: Prompts, reporter: Reporter): Promise<Admin> {
  const username = await prompted(prompts, reporter, 'Administrator username', value => value !== '', 'Enter a username.')
  const address = await prompted(
    prompts,
    reporter,
    'Administrator email',
    value => email.safeParse(value).success,
    'Enter a valid email address.',
  )
  while (true) {
    const password = await prompted(
      prompts,
      reporter,
      'Administrator password',
      value => value.length >= MINIMUM_PASSWORD_LENGTH,
      `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
      true,
    )
    if (password === (await prompts.secret('Confirm password'))) {
      return { username, email: address, password }
    }
    reporter.info('The passwords did not match.')
  }
}

/**
 * A failed probe or browser never fails a verified startup: it only says that
 * this machine could not confirm the origin, which is not a statement about the
 * service.
 */
async function openOrigin(reporter: Reporter, origin: string, signal: AbortSignal): Promise<void> {
  reporter.section('Browser')
  const reachable = await fetch(`${origin}/health`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
  }).then(
    response => response.ok,
    () => false,
  )
  if (!reachable) {
    reporter.notice(
      `${origin} did not answer from this machine, so no browser was opened. This does not show that the services are down: DNS, certificate trust, or routing from here may differ.`,
    )
    return
  }
  reporter.row('verified', 'Origin', `${origin}/health answered from this machine · public trust beyond this check is not established`)
  if (await openInBrowser(origin)) {
    reporter.info(`Requested ${origin} from the default browser.`)
  } else {
    reporter.notice(`No browser could be started. Open ${origin} yourself.`)
  }
}

/**
 * Offers startup after a configured installation. A stopped orchestrator is
 * started only after its own default-no approval on an interactive terminal,
 * and declining is not a cancellation: the installation simply stays configured
 * and stopped. A running one is only checked for readiness. Runs under the
 * installation lock held by the caller.
 */
export async function start(context: StartContext): Promise<StartState> {
  const { directory, name, client, retry, prompts, reporter, signal, observation } = context
  const instance = observation.instance?.value
  const origin = observation.ingress?.origin
  if (instance === undefined || origin === undefined) {
    throw new InstallerError({ code: 'INTERNAL_ERROR' })
  }
  if (isStopped(instance) && !isInteractive()) {
    reporter.info('No terminal is available to approve startup, so the orchestrator was left stopped.')
    return 'stopped'
  }
  let declined = false
  const sink = stepSink(reporter, START_STEPS, RESULTS)
  const starter = await Starter.open({
    directory,
    name,
    client,
    retry,
    hooks: {
      show: plan => reportStart(reporter, plan),
      approve: async () => {
        if (!(await prompts.consent('Install, build, and start the orchestrator'))) {
          declined = true
          throw new InstallerError({ code: 'COMMAND_CANCELLED' })
        }
        reporter.section('Applying')
      },
      admin: () => askAdmin(prompts, reporter),
      progress: (phase, action) => sink({ phase, action }),
    },
  })
  if (!isStopped(instance)) {
    reporter.section('Startup')
    await starter.requireReady()
    reporter.row('verified', 'Services', 'the orchestrator is running and its services answer inside the guest')
  } else {
    try {
      await starter.run(signal)
    } catch (error: unknown) {
      if (declined) {
        return 'stopped'
      }
      throw error
    }
  }
  await openOrigin(reporter, origin, signal)
  return 'running'
}