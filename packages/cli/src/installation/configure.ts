import { createHash, randomUUID } from 'node:crypto'
import { INSTALLER_SPEC } from './spec'
import { apply } from './apply'
import { verify } from './verify'
import { planOf, type PlanRequest } from './plan'
import { observe, type Observation } from './observe'
import { createCredentials, replaceRoster } from './credentials'
import { pinCheckout, pinImage, pinned } from './state'
import { CHECKOUT_DIGEST } from './checkout/manifest'
import { requireNotStuck, returned } from './journal/facts'
import { validateContainerImage } from './preflight/image'
import { canonical, sameJson } from '../json'
import { InstallerError } from '../diagnostic/error'
import { stateOf, type StepState } from '../journal/step'
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
import type { StepOutcome } from '../host/step'
import type { Retry } from './retry'
import type { Dir, FileSnapshot } from '../state/files'
import type { ImageSource } from './image'
import type { InstallationRecord } from './records'
import type { CheckoutAccess } from './target/types'
import type { InstallationInputs } from './types'

/**
 * No scripts are approved here for Incus, so the recipe identifies the installer
 * specification that was in force when the plan was approved, together with the
 * embedded checkout scripts.
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
  'update-instance': 'deliver the credentials to the stopped orchestrator instance',
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
 * The command owns presentation and consent. `show` renders the plan the moment
 * it is derived, and `approve` resolves only when the operator approved the
 * plan that was just shown.
 */
export interface ConfigureHooks {
  show(plan: ConfigurePlan): void
  approve(plan: ConfigurePlan): Promise<void>
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
 * The plan that was applied, or the empty plan of an installation that already
 * matched, and the fresh observation that agreed with it.
 */
export interface ConfigureResult {
  plan: ConfigurePlan
  observation: Observation
}

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

/**
 * A cancellation is reported as such, so the caller can describe what it left
 * behind. Anything else carries the authored outcome of the remote script.
 */
function remoteFailure(
  action: InstallAction,
  outcome: Exclude<StepOutcome, { kind: 'returned' }>,
  retry: string,
): InstallerError {
  if (outcome.cause?.kind === 'cancelled') {
    return outcome.cause
  }
  return new InstallerError({
    code: 'INSTALLATION_STEP_FAILED',
    facts: [
      ['Step', action],
      [
        'Outcome',
        outcome.kind === 'refused'
          ? 'refused; the step had no effect'
          : 'uncertain; the step may have run partly or fully',
      ],
      ['Reason', outcome.reason],
      ...(outcome.cause?.facts ?? []),
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
 * by the command. Per step: the authorization is persisted, then the fence, then
 * the single Incus request or remote script runs, then its outcome is persisted,
 * then a fresh observation must agree before `verifiedAt` is persisted. The plan
 * is derived again after approval and must be unchanged before anything is
 * persisted. The managed checkout is cloned first, so a clone failure never
 * follows an image upload. A split image is imported without an alias and must
 * be a container image for the target architecture before it is verified and
 * before the previous image is deleted. Nothing is replayed, resumed, or rolled
 * back, and an interrupted step stays open as evidence. The pins and the local
 * credential files are atomic local writes covered by the approval, and they are
 * not journaled steps. Cancellation stops before the next step, and the
 * diagnostic states what it left behind for the newest one.
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
   * evidence. An installation that already matches needs no approval.
   */
  public async run(signal: AbortSignal): Promise<ConfigureResult> {
    const observation = (await this.settleReturned()) ?? (await this.fresh())
    const plan = planOf(observation, this.planRequest)
    this.context.hooks.show(plan)
    if (isEmpty(plan)) {
      return { plan, observation }
    }
    const current = await this.confirm(plan)
    return await this.execute(plan, current, signal)
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
   * The operator may take a while to approve, so the plan is derived again from
   * a fresh observation, and it must be exactly the plan that was approved.
   * This refuses before anything is persisted.
   */
  private async confirm(plan: ConfigurePlan): Promise<Observation> {
    await this.context.hooks.approve(plan)
    const current = await this.fresh()
    if (!sameJson(planOf(current, this.planRequest), plan)) {
      throw new InstallerError({
        code: 'INSTALLATION_PLAN_CHANGED',
        retry: this.context.retry.configure,
      })
    }
    return current
  }

  /**
   * Applies the approved plan, and reports a cancellation together with what it
   * left behind for the newest step.
   */
  private async execute(plan: ConfigurePlan, observation: Observation, signal: AbortSignal): Promise<ConfigureResult> {
    try {
      return await this.applyActions(plan, observation, signal)
    } catch (error: unknown) {
      throw this.describeCancellation(error)
    }
  }

  /**
   * Runs the approved actions: the checkout first, then the image actions, then
   * the pin, then the rest. The whole installation is observed once more at the
   * end, and it must need nothing further.
   */
  private async applyActions(
    plan: ConfigurePlan,
    observation: Observation,
    signal: AbortSignal,
  ): Promise<ConfigureResult> {
    const authorization = await this.authorize(plan)
    let latest = observation
    if (plan.checkout !== null) {
      latest = await this.materialize(authorization, plan, plan.checkout, signal)
    }
    const actions = actionsOf(plan).filter(isIncusAction)
    for (const action of actions.filter(isImageAction)) {
      latest = await this.perform(authorization, plan, action, latest, signal)
    }
    await this.pin(plan)
    for (const action of actions.filter(item => !isImageAction(item))) {
      latest = await this.perform(authorization, plan, action, latest, signal)
    }
    const final = await this.fresh()
    if (!isEmpty(planOf(final, this.planRequest))) {
      throw unverified(this.installation.name, 'the complete installation', this.context.retry.configure)
    }
    checkCancellation(signal)
    return { plan, observation: final }
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
   * snapshot that includes them. Cancellation is checked before each action,
   * so none starts after it.
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
   * The source phase. The restore point is pinned first, so an interruption
   * stays recoverable by running configure again. The remote outcome is
   * classified like any other step, and a fresh observation must show the
   * checkout before the step counts as verified.
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
    await this.concludeRemote('materialize-checkout', await checkout.materialize(source.commit))
    return await this.verified(plan, 'materialize-checkout')
  }

  /**
   * The imported image stays in the store without an alias when it does not
   * fit. Qiln never deletes it, so the diagnostic says the operator must.
   */
  private requireContainerImage({ image, fingerprint }: Observation): void {
    const { inputs, retry } = this.context
    if (image === null) {
      throw unverified(this.installation.name, 'the imported image', retry.configure)
    }
    try {
      validateContainerImage(image, fingerprint, inputs.architecture, retry.configure)
    } catch (error: unknown) {
      if (!(error instanceof InstallerError)) {
        throw error
      }
      throw new InstallerError({
        code: error.code,
        facts: [
          ...error.facts,
          [
            'Imported image',
            `${fingerprint} remains in the Incus image store without an alias. The previous image was not deleted, and Qiln never deletes the imported one: remove it manually.`,
          ],
        ],
        retry: error.retry,
      })
    }
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
    return await this.verified(plan, action)
  }

  /**
   * Records what the remote script reported. A refusal or an unconfirmed outcome
   * is recorded and then thrown, so cancellation is classified before it
   * propagates. A step with no exit status stays open, which is uncertain.
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
        throw remoteFailure(action, outcome, retry.configure)
      case 'uncertain':
        if (outcome.exitCode !== null) {
          await this.amend({ completion: { exitCode: outcome.exitCode, completedAt: at } })
        }
        throw remoteFailure(action, outcome, retry.configure)
    }
  }

  /**
   * A client error before the request was accepted, or a local refusal raised
   * before any request was sent, is a definite absence of effect. A cancelled
   * request is the same only when it never reached the daemon and no operation
   * was accepted. A completed but unsuccessful operation is recorded as a
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
   * An imported image is judged here, before its step is stamped verified, so a
   * step never claims an image that is not a container image for the target
   * architecture.
   */
  private async verified(plan: ConfigurePlan, action: InstallAction): Promise<Observation> {
    const { inputs, retry } = this.context
    const observation = await this.fresh()
    if (!verify(action, plan, observation, inputs, retry.configure)) {
      throw unverified(this.installation.name, `step ${action}`, retry.configure)
    }
    if (action === 'import-image') {
      this.requireContainerImage(observation)
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
