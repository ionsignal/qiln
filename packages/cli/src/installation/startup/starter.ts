import { createHash } from 'node:crypto'
import { INSTALLER_SPEC } from '../spec'
import { Guest, WAIT_SCRIPT } from './guest'
import { requireNotStuck } from '../journal/facts'
import { StepJournal } from '../../journal/runner'
import { stateOf } from '../../journal/step'
import { canonical } from '../../json'
import { InstallerError } from '../../diagnostic/error'
import { actionsOf, type Admin, type StartupAction, type StartupEvidence, type StartupPlan } from './types'
import * as records from './records'
import type { Dir } from '../../state/files'
import type { IncusClient } from '../../transport/incus/client'
import type { Retry } from '../retry'

/**
 * Identifies the installer specification and the polling script in force at
 * approval. It grants no authority.
 */
const RECIPE = Object.freeze({
  revision: INSTALLER_SPEC.evidenceVersion,
  digest: createHash('sha256').update(canonical(INSTALLER_SPEC)).update(WAIT_SCRIPT).digest('hex'),
})

type StartupJournal = StepJournal<StartupEvidence, StartupPlan, StartupAction>

/**
 * The command owns presentation and consent. `show` renders the plan, `approve`
 * resolves only when the operator approved it, and `admin` prompts for the first
 * administrator after that approval and before any step. `progress` only observes.
 */
export interface StartupHooks {
  show(plan: StartupPlan): void
  approve(plan: StartupPlan): Promise<void>
  admin(): Promise<Admin>
  progress(phase: 'working' | 'verified', action: StartupAction): void
}

export interface StartupContext {
  directory: Dir
  name: string
  client: IncusClient
  hooks: StartupHooks
  retry: Retry
}

/**
 * Coordinates one startup of the stopped orchestrator under the installation
 * lock held by the command. Per step: authorization persisted, fence persisted,
 * one Incus request or guest command, outcome persisted, then a fresh check
 * must agree before `verifiedAt` is persisted. A unit step is verified by the
 * zero exit of its transient unit, which shows completion and not application
 * correctness. Nothing is replayed, resumed, or rolled back, and an interrupted
 * step stays open as evidence.
 */
export class Starter {
  private constructor(
    private readonly context: StartupContext,
    private readonly guest: Guest,
    private readonly journal: StartupJournal,
  ) {}

  /**
   * A step left returned is verified here, before anything new is authorized,
   * because a new authorization needs every step settled.
   */
  public static async open(context: StartupContext): Promise<Starter> {
    const { directory, name, client, hooks, retry } = context
    const evidence = (await records.read(directory, retry.inspect)) ?? records.blank()
    requireNotStuck(evidence, name, retry.inspect)
    const guest = new Guest(client, retry.configure)
    const journal: StartupJournal = new StepJournal({
      record: evidence,
      save: next => records.save(directory, next, retry.inspect),
      recipe: RECIPE,
      failureCode: 'STARTUP_STEP_FAILED',
      retry: retry.configure,
      run: (_plan, action) => guest.run(action),
      approve: plan => hooks.approve(plan),
      progress: (phase, action) => hooks.progress(phase, action),
    })
    const starter = new Starter(context, guest, journal)
    await journal.settle((_plan, action) => starter.verify(action))
    return starter
  }

  /**
   * Derived from evidence alone: the operator is asked for an administrator
   * until one creation was verified.
   */
  public plan(): StartupPlan {
    const created = this.journal.record.steps.some(
      step => step.action === 'create-admin' && stateOf(step) === 'verified',
    )
    return { kind: 'startup', admin: !created }
  }

  /**
   * One point-in-time check that the services answer inside the guest.
   */
  public async requireReady(): Promise<void> {
    if (!(await this.guest.wait('ready', 0))) {
      throw this.unverified('the running services')
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    const { hooks } = this.context
    const plan = this.plan()
    hooks.show(plan)
    const authorization = await this.journal.authorize(plan)
    const admin = plan.admin ? await hooks.admin() : null
    for (const action of actionsOf(plan)) {
      if (action === 'create-admin' && admin !== null) {
        await this.guest.writeAdmin(admin)
      }
      await this.journal.step(authorization, plan, action, signal, () => this.verify(action))
    }
  }

  private unverified(subject: string): InstallerError {
    return new InstallerError({
      code: 'INSTALLATION_NOT_VERIFIED',
      facts: [
        ['Installation', this.context.name],
        ['Unverified', subject],
      ],
      retry: this.context.retry.configure,
    })
  }

  private async verify(action: StartupAction): Promise<void> {
    const { guest } = this
    let verified = true
    if (action === 'start-instance') {
      verified = (await guest.running()) && (await guest.wait('prerequisites'))
    } else if (action === 'start-services') {
      verified = await guest.wait('ready')
    }
    if (!verified) {
      throw this.unverified(`startup step ${action}`)
    }
    await this.journal.amend({ verifiedAt: new Date().toISOString() })
  }
}
