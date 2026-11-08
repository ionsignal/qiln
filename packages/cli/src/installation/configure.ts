import { createHash, randomUUID } from 'node:crypto'
import { INSTALLER_SPEC } from './spec'
import { CHECKOUT_DIGEST } from './checkout/manifest'
import { apply } from './apply'
import { verify } from './verify'
import { firstGate, planOf, requireContainer, type ImageReplacement, type PlanRequest } from './plan'
import { observe, type Observation } from './observe'
import { createCredentials, replaceRoster } from './credentials'
import { pinCheckout, pinImage, pinned } from './state'
import { canonical, sameJson } from '../json'
import { requireNotStuck, returned } from './journal/facts'
import { InstallerError } from '../diagnostic/error'
import { stateOf, type StepState } from '../journal/step'
import { stepFailure, type StepOutcome } from '../host/step'
import { toInstallerError } from '../transport/incus/errors'
import { checkCancellation } from '../terminal/prompts'
import { currentUserId } from '../state/user'
import {
  IncusApiError,
  IncusCancelledError,
  IncusOperationError,
  type IncusClient,
} from '../transport/incus/client'
import {
  actionsOf,
  isEmpty,
  isIncusAction,
  type ConfigureAuthorization,
  type ConfigureEvidence,
  type ConfigurePlan,
  type ConfigureStep,
  type IncusAction,
  type InstallAction,
} from './journal/types'
import * as records from './journal/records'
import type { Retry } from './retry'
import type { Dir, FileSnapshot } from '../state/files'
import type { ImageSource } from './image'
import type { InstallationRecord } from './records'
import type { CheckoutAccess } from './target/types'
import type { InstallationInputs } from './types'

/**
 * No Incus scripts are approved here, so the recipe identifies the installer
 * specification in force at approval together with the embedded checkout
 * scripts.
 */
const RECIPE = Object.freeze({
  revision: INSTALLER_SPEC.evidenceVersion,
  digest: createHash('sha256').update(canonical(INSTALLER_SPEC)).update(CHECKOUT_DIGEST).digest('hex'),
})

/**
 * The installation pin is written once these have run, so a failed image step
 * never leaves a pin for content that is not in the store.
 */
const IMAGE_ACTIONS: readonly IncusAction[] = ['import-image', 'delete-image', 'create-alias']

function isImageAction(action: IncusAction): boolean {
  return IMAGE_ACTIONS.includes(action)
}

const OPERATIONS: Record<IncusAction, string> = {
  'delete-image': 'delete the previous image targeted by the managed orchestrator alias',
  'import-image': 'upload and import the staged split Incus image',
  'create-alias': 'create the managed orchestrator image alias',
  'create-network': 'create the managed bridge network',
  'create-volume': 'create the Qiln PostgreSQL custom volume',
  'create-instance': 'create the stopped orchestrator instance',
  'update-instance': 'deliver the credentials and published ports to the stopped orchestrator instance',
}

/**
 * What a cancellation leaves behind for the newest step, by its journal state.
 */
const CANCELLED_STEP_OUTCOMES: Record<StepState, string> = {
  open: 'uncertain; the step may have run partly or fully, and it blocks configuration until resolved',
  uncertain: 'uncertain; the step may have run partly or fully, and it blocks configuration until resolved',
  returned: 'exited zero; the next run verifies it from a fresh observation',
  refused: 'settled; the step had no effect',
  verified: 'settled; a fresh observation agreed',
}

/**
 * `working` follows the fence of a step, and `verified` follows only after a
 * fresh observation agreed and the verification was persisted. A step that was
 * refused or left uncertain emits nothing further, so the failure diagnostic
 * owns what the operator sees.
 */
export interface ConfigureProgress {
  phase: 'working' | 'verified'
  action: InstallAction
}

/**
 * The command owns presentation and consent. `show` renders the plan the moment
 * it is derived, and `approve` resolves only when the operator approved the
 * plan that was just shown. `held` is the image deletion that the first gate of
 * a replacement postpones to its own approval, and null otherwise. `progress`
 * only observes.
 */
export interface ConfigureHooks {
  show(plan: ConfigurePlan, held: ImageReplacement | null): void
  approve(plan: ConfigurePlan, held: ImageReplacement | null): Promise<void>
  progress(event: ConfigureProgress): void
}

export interface ConfigureContext {
  directory: Dir
  installation: InstallationRecord
  client: IncusClient
  inputs: InstallationInputs
  checkout: CheckoutAccess
  source: ImageSource
  sshKeygen: string
  roster: FileSnapshot | null
  hooks: ConfigureHooks
  retry: Retry
}

/**
 * The plan that was applied (the full plan when it was approved in gates), or
 * the empty plan of an installation that already matched, and the fresh
 * observation that agreed with it.
 */
export interface ConfigureResult {
  plan: ConfigurePlan
  observation: Observation
}

/**
 * Maps the plan derived from a fresh observation to the part that one approval
 * covers.
 */
type Projection = (plan: ConfigurePlan) => ConfigurePlan | null

const wholePlan: Projection = plan => plan

function failure(
  action: IncusAction,
  outcome: 'refused' | 'uncertain',
  error: unknown,
  retry: string,
): InstallerError {
  const cause = toInstallerError(error, {
    check: 'installation step',
    operation: OPERATIONS[action],
    rerun: retry,
  })
  return new InstallerError({
    code: 'INSTALLATION_STEP_FAILED',
    facts: [
      ['Step', action],
      [
        'Outcome',
        outcome === 'refused'
          ? 'refused; the step had no effect'
          : 'uncertain; the step may have run partly or fully',
      ],
      ['Reason', cause.message],
      ...cause.facts,
    ],
    retry,
  })
}

function unverified(installation: string, subject: string, retry: string): InstallerError {
  return new InstallerError({
    code: 'INSTALLATION_NOT_VERIFIED',
    facts: [
      ['Installation', installation],
      ['Unverified', subject],
    ],
    retry,
  })
}

/**
 * Coordinates one installation configuration under the installation lock held
 * by the command. Per step: authorization persisted, fence persisted, one Incus
 * request or remote script, outcome persisted, then a fresh observation must
 * agree before `verifiedAt` is persisted. The plan is derived again after
 * approval and must be unchanged. The managed checkout is cloned first, and a
 * split image is imported without an alias and checked before any previous
 * image is deleted, which `firstGate` separates into its own approval. Nothing
 * is replayed, resumed, or rolled back, and an interrupted step stays open as
 * evidence. The pins and credential files are atomic local writes covered by
 * the approval, not journaled steps.
 */
export class Configurer {
  private constructor(
    private readonly context: ConfigureContext,
    private installation: InstallationRecord,
    private evidence: ConfigureEvidence,
  ) {}

  public static async open(context: ConfigureContext): Promise<Configurer> {
    const { directory, installation, retry } = context
    const evidence = (await records.read(directory, installation, retry.inspect)) ?? records.blank()
    requireNotStuck(evidence, installation.name, retry.inspect)
    return new Configurer(context, installation, evidence)
  }

  /**
   * Verifies a step left returned by an earlier run, then plans from fresh
   * evidence. An installation that already matches needs no approval. A plan
   * that replaces the managed image is approved in two gates (see `firstGate`),
   * and the result keeps the full plan.
   */
  public async run(signal: AbortSignal): Promise<ConfigureResult> {
    const observed = (await this.settleReturned()) ?? (await this.fresh())
    const full = planOf(observed, this.planRequest)
    if (isEmpty(full)) {
      return { plan: full, observation: observed }
    }
    const first = firstGate(full)
    let remaining = full
    if (first !== null) {
      remaining = planOf(await this.applyGate(first, full.image.replace, firstGate, signal), this.planRequest)
    }
    await this.applyGate(remaining, null, wholePlan, signal)
    return { plan: full, observation: await this.guarded(() => this.verifyComplete(signal)) }
  }

  private get planRequest(): PlanRequest {
    const { inputs, roster, retry } = this.context
    return { inputs, roster, retry }
  }

  private async fresh(): Promise<Observation> {
    const { client, directory, sshKeygen, source, inputs, checkout, retry } = this.context
    return await observe({
      client,
      directory,
      sshKeygen,
      source,
      installation: pinned(this.installation),
      checkoutCommit: this.installation.checkoutCommit,
      checkout,
      inputs,
      retry,
    })
  }

  /**
   * Presentation cannot decide whether a step completed or verified.
   */
  private notify(phase: ConfigureProgress['phase'], action: InstallAction): void {
    try {
      this.context.hooks.progress({ phase, action })
    } catch {
      // Intentionally ignored.
    }
  }

  /**
   * Shows one gate, waits for its approval, applies it, and returns the last
   * observation that verified a step.
   */
  private async applyGate(
    plan: ConfigurePlan,
    held: ImageReplacement | null,
    projection: Projection,
    signal: AbortSignal,
  ): Promise<Observation> {
    this.context.hooks.show(plan, held)
    const current = await this.confirm(plan, held, projection)
    return await this.guarded(() => this.applyActions(plan, current, signal))
  }

  /**
   * The operator may take a while to approve, so the plan is derived again from
   * a fresh observation, and the part that this approval covers must be exactly
   * what was approved. This refuses before anything is persisted.
   */
  private async confirm(
    plan: ConfigurePlan,
    held: ImageReplacement | null,
    projection: Projection,
  ): Promise<Observation> {
    await this.context.hooks.approve(plan, held)
    const current = await this.fresh()
    if (!sameJson(projection(planOf(current, this.planRequest)), plan)) {
      throw new InstallerError({
        code: 'INSTALLATION_PLAN_CHANGED',
        retry: this.context.retry.configure,
      })
    }
    return current
  }

  /**
   * Reports a cancellation together with what it left behind for the newest
   * step.
   */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      throw this.describeCancellation(error)
    }
  }

  /**
   * Runs the approved actions: the checkout first, then the image actions, then
   * the pin, then the rest. An imported image is judged as a container image
   * right after its step, so no alias, pin, or deletion follows content that
   * does not fit.
   */
  private async applyActions(plan: ConfigurePlan, observation: Observation, signal: AbortSignal): Promise<Observation> {
    const authorization = await this.authorize(plan)
    let latest = observation
    if (plan.checkout !== null) {
      latest = await this.materialize(authorization, plan, plan.checkout, signal)
    }
    const actions = actionsOf(plan).filter(isIncusAction)
    for (const action of actions.filter(isImageAction)) {
      latest = await this.perform(authorization, plan, action, latest, signal)
      if (action === 'import-image') {
        requireContainer(latest, this.context.inputs, this.context.retry.configure)
      }
    }
    await this.pin(plan)
    for (const action of actions.filter(item => !isImageAction(item))) {
      latest = await this.perform(authorization, plan, action, latest, signal)
    }
    return latest
  }

  /**
   * The whole installation is observed once more and must need nothing further.
   */
  private async verifyComplete(signal: AbortSignal): Promise<Observation> {
    const final = await this.fresh()
    if (!isEmpty(planOf(final, this.planRequest))) {
      throw unverified(this.installation.name, 'the complete installation', this.context.retry.configure)
    }
    checkCancellation(signal)
    return final
  }

  private describeCancellation(error: unknown): unknown {
    const step = this.evidence.steps.at(-1)
    if (!(error instanceof InstallerError) || error.code !== 'COMMAND_CANCELLED' || step === undefined) {
      return error
    }
    const state = stateOf(step)
    return new InstallerError({
      code: error.code,
      facts: [
        ['Installation', this.installation.name],
        ['Last step', `${step.action} (${state})`],
        ['Last step outcome', CANCELLED_STEP_OUTCOMES[state]],
      ],
      retry: this.context.retry.configure,
    })
  }

  private get lastStep(): ConfigureStep {
    const step = this.evidence.steps.at(-1)
    if (step === undefined) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    return step
  }

  private async persist(changes: Partial<ConfigureEvidence>): Promise<void> {
    const next = { ...this.evidence, ...changes }
    await records.save(this.context.directory, this.installation, next, this.context.retry.inspect)
    this.evidence = next
  }

  private async amend(change: Partial<ConfigureStep>): Promise<void> {
    await this.persist({
      steps: [...this.evidence.steps.slice(0, -1), { ...this.lastStep, ...change }],
    })
  }

  private async authorize(plan: ConfigurePlan): Promise<string> {
    const authorization: ConfigureAuthorization = {
      id: randomUUID(),
      approvedAt: new Date().toISOString(),
      approvedBy: { method: 'local-interactive', userId: currentUserId() },
      recipe: { revision: RECIPE.revision, digest: RECIPE.digest },
      plan,
      host: this.installation.host,
    }
    await this.persist({ authorizations: [...this.evidence.authorizations, authorization] })
    return authorization.id
  }

  private async pin(plan: ConfigurePlan): Promise<void> {
    if (plan.pin && this.installation.imageFingerprint !== plan.fingerprint) {
      this.installation = await pinImage(
        this.context.directory,
        this.installation,
        plan.fingerprint,
        this.context.retry,
      )
    }
  }

  /**
   * Local-only: the instance receives these files in the guarded update that
   * follows. A roster is present whenever the plan generates or replaces.
   */
  private async writeCredentials(plan: ConfigurePlan): Promise<void> {
    const { directory, sshKeygen, roster, retry } = this.context
    if (plan.credentials === 'reuse') {
      return
    }
    if (roster === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    if (plan.credentials === 'generate') {
      await createCredentials(directory, roster, sshKeygen, retry.configure)
    } else {
      await replaceRoster(directory, roster, sshKeygen, retry.configure)
    }
  }

  /**
   * One approved Incus action. Credentials are written locally just before the
   * guarded instance update and observed again, so the update is built from a
   * snapshot that includes them. No action starts after a cancellation.
   */
  private async perform(
    authorization: string,
    plan: ConfigurePlan,
    action: IncusAction,
    observation: Observation,
    signal: AbortSignal,
  ): Promise<Observation> {
    checkCancellation(signal)
    let current = observation
    if (action === 'update-instance') {
      await this.writeCredentials(plan)
      current = await this.fresh()
    }
    return await this.step(authorization, plan, action, current)
  }

  /**
   * The restore point is pinned first, so an interruption stays recoverable by
   * running configure again. A fresh observation must show the checkout before
   * the step counts as verified.
   */
  private async materialize(
    authorization: string,
    plan: ConfigurePlan,
    source: NonNullable<ConfigurePlan['checkout']>,
    signal: AbortSignal,
  ): Promise<Observation> {
    const { checkout, directory, retry } = this.context
    if (checkout.kind !== 'managed') {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    checkCancellation(signal)
    if (this.installation.checkoutCommit !== source.commit) {
      this.installation = await pinCheckout(directory, this.installation, source.commit, retry.inspect)
    }
    await this.fence(authorization, 'materialize-checkout')
    this.notify('working', 'materialize-checkout')
    await this.concludeRemote('materialize-checkout', await checkout.materialize(source.commit))
    const observed = await this.verified(plan, 'materialize-checkout')
    this.notify('verified', 'materialize-checkout')
    return observed
  }

  /**
   * The step is open from here on, and stays open as evidence if the process
   * ends before its outcome is persisted.
   */
  private async fence(authorization: string, action: InstallAction): Promise<void> {
    await this.persist({
      steps: [
        ...this.evidence.steps,
        {
          id: randomUUID(),
          authorization,
          action,
          fencedAt: new Date().toISOString(),
          completion: null,
          refusedAt: null,
          verifiedAt: null,
        },
      ],
    })
  }

  private async step(
    authorization: string,
    plan: ConfigurePlan,
    action: IncusAction,
    observation: Observation,
  ): Promise<Observation> {
    const { client, inputs, source, retry } = this.context
    await this.fence(authorization, action)
    this.notify('working', action)
    let accepted = false
    try {
      await apply(action, plan, observation, {
        client,
        inputs,
        source,
        retry,
        accepted: async operation => {
          accepted = true
          await this.persist({
            operations: [
              ...this.evidence.operations,
              { step: this.lastStep.id, id: operation.id, path: operation.path },
            ],
          })
        },
      })
    } catch (error: unknown) {
      return await this.concludeRequest(action, error, accepted)
    }
    await this.amend({ completion: { exitCode: 0, completedAt: new Date().toISOString() } })
    const observed = await this.verified(plan, action)
    this.notify('verified', action)
    return observed
  }

  /**
   * Records what the remote script reported. A refusal or an unconfirmed
   * outcome is recorded and then thrown, so cancellation is classified before
   * it propagates. A step with no exit status stays open, which is uncertain.
   */
  private async concludeRemote(action: InstallAction, outcome: StepOutcome): Promise<void> {
    const { retry } = this.context
    const at = new Date().toISOString()
    switch (outcome.kind) {
      case 'returned':
        await this.amend({ completion: { exitCode: 0, completedAt: at } })
        return
      case 'refused':
        await this.amend({ refusedAt: at })
        throw stepFailure('INSTALLATION_STEP_FAILED', retry.configure, action, outcome)
      case 'uncertain':
        if (outcome.exitCode !== null) {
          await this.amend({ completion: { exitCode: outcome.exitCode, completedAt: at } })
        }
        throw stepFailure('INSTALLATION_STEP_FAILED', retry.configure, action, outcome)
    }
  }

  /**
   * A client error before the request was accepted, a local refusal before any
   * request was sent, and a cancelled request that never reached the daemon are
   * definite absences of effect. A completed but unsuccessful operation is a
   * nonzero completion. Anything else leaves the step open, because a timeout,
   * a cancelled wait or upload, or a lost connection does not show that nothing
   * changed.
   */
  private async concludeRequest(action: IncusAction, error: unknown, accepted: boolean): Promise<never> {
    const { retry } = this.context
    const at = new Date().toISOString()
    if (error instanceof IncusCancelledError) {
      if (!accepted && !error.dispatched) {
        await this.amend({ refusedAt: at })
      }
      throw new InstallerError({
        code: 'COMMAND_CANCELLED',
      })
    }
    if (error instanceof IncusOperationError) {
      await this.amend({ completion: { exitCode: 1, completedAt: at } })
      throw failure(action, 'uncertain', error, retry.configure)
    }
    const refused =
      !accepted &&
      (error instanceof InstallerError ||
        (error instanceof IncusApiError && error.statusCode >= 400 && error.statusCode < 500))
    if (refused) {
      await this.amend({ refusedAt: at })
      throw failure(action, 'refused', error, retry.configure)
    }
    throw failure(action, 'uncertain', error, retry.configure)
  }

  /**
   * Verifies the effect of one step against a fresh observation. An imported
   * image is only observed present here, so the step is truthfully verified once
   * the content is in the store. Whether that content is a container image for
   * the target architecture is judged by `requireContainer`, right after the
   * import and again by planning.
   */
  private async verified(plan: ConfigurePlan, action: InstallAction): Promise<Observation> {
    const { inputs, retry } = this.context
    const observation = await this.fresh()
    if (!verify(action, plan, observation, inputs, retry.configure)) {
      throw unverified(this.installation.name, `step ${action}`, retry.configure)
    }
    await this.amend({ verifiedAt: new Date().toISOString() })
    return observation
  }

  /**
   * A step that exited zero but was never verified is accounting work, not
   * replay: only a fresh observation is needed.
   */
  private async settleReturned(): Promise<Observation | null> {
    const pending = returned(this.evidence).at(-1)
    if (pending === undefined) {
      return null
    }
    const plan = this.evidence.authorizations.find(({ id }) => id === pending.authorization)?.plan
    if (plan === undefined) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
        retry: this.context.retry.configure,
      })
    }
    return await this.verified(plan, pending.action)
  }
}
