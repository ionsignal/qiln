import { createHash, randomUUID } from 'node:crypto'
import { canonical, sameJson } from '../json'
import { InstallerError } from '../diagnostic/error'
import { IncusApiError, IncusOperationError, type IncusClient } from '../incus/client'
import { toInstallerError } from '../incus/errors'
import { checkCancellation } from '../terminal/prompts'
import { apply } from './apply'
import { createCredentials, replaceRoster } from './credentials'
import { observe, type Observation } from './observe'
import { planOf } from './plan'
import { INSTALLER_SPEC } from './spec'
import { currentUserId, pinImage, pinned } from './state'
import { verify } from './verify'
import { requireNotStuck, returned } from './journal/facts'
import {
  actionsOf,
  isEmpty,
  type ConfigureAuthorization,
  type ConfigureEvidence,
  type ConfigurePlan,
  type ConfigureStep,
  type InstallAction,
} from './journal/types'
import * as records from './journal/records'
import type { Dir, FileSnapshot } from '../state/files'
import type { ImageSource } from './image'
import type { InstallationRecord } from './records'
import type { InstallationInputs } from './types'

const RERUN =
  'qiln up --source <checkout> (--image <alias-or-fingerprint> | --image-meta <incus.tar.xz> --image-rootfs <rootfs.squashfs>) [--authorized-keys <roster>]'

/**
 * No scripts are approved here, so the recipe identifies the installer
 * specification that was in force when the plan was approved.
 */
const RECIPE = Object.freeze({
  revision: INSTALLER_SPEC.evidenceVersion,
  digest: createHash('sha256').update(canonical(INSTALLER_SPEC)).digest('hex'),
})

/**
 * The installation pin is written once these have run, so a failed image step
 * never leaves a pin for content that is not in the store.
 */
const IMAGE_ACTIONS: readonly InstallAction[] = ['delete-image', 'import-image', 'create-alias']

const OPERATIONS: Record<InstallAction, string> = {
  'delete-image': 'delete the previous image targeted by the managed orchestrator alias',
  'import-image': 'upload and import the staged split Incus image',
  'create-alias': 'create the managed orchestrator image alias',
  'create-network': 'create the managed bridge network',
  'create-volume': 'create the Qiln PostgreSQL custom volume',
  'create-instance': 'create the stopped orchestrator instance',
  'update-instance': 'deliver the credentials to the stopped orchestrator instance',
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
  source: ImageSource
  sshKeygen: string
  roster: FileSnapshot | null
  hooks: ConfigureHooks
}

/**
 * The plan that was applied, or the empty plan of an installation that already
 * matched, and the fresh observation that agreed with it.
 */
export interface ConfigureResult {
  plan: ConfigurePlan
  observation: Observation
}

function failure(action: InstallAction, outcome: 'refused' | 'uncertain', error: unknown): InstallerError {
  const cause = toInstallerError(error, {
    check: 'installation step',
    operation: OPERATIONS[action],
    rerun: RERUN,
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
    retry: RERUN,
  })
}

function unverified(installation: string, subject: string): InstallerError {
  return new InstallerError({
    code: 'INSTALLATION_NOT_VERIFIED',
    facts: [
      ['Installation', installation],
      ['Unverified', subject],
    ],
    retry: RERUN,
  })
}

/**
 * Coordinates one installation configuration under the installation lock held
 * by the command. Per step: the authorization is persisted, then the fence, then
 * the single Incus request runs, then its outcome is persisted, then a fresh
 * observation must agree before `verifiedAt` is persisted. The plan is derived
 * again after approval and must be unchanged before anything is persisted.
 * Nothing is replayed, resumed, or rolled back, and an interrupted step stays
 * open as evidence. The pin and the local credential files are atomic local
 * writes covered by the approval, and they are not journaled steps.
 */
export class Configurer {
  private constructor(
    private readonly context: ConfigureContext,
    private installation: InstallationRecord,
    private evidence: ConfigureEvidence,
  ) {}

  public static async open(context: ConfigureContext): Promise<Configurer> {
    const { directory, installation } = context
    const evidence = (await records.read(directory, installation)) ?? records.blank(installation)
    requireNotStuck(evidence, installation.name)
    return new Configurer(context, installation, evidence)
  }

  /**
   * Verifies a step left returned by an earlier run, then plans from fresh
   * evidence. An installation that already matches needs no approval.
   */
  public async run(signal: AbortSignal): Promise<ConfigureResult> {
    const { hooks, inputs, roster } = this.context
    const observation = (await this.settleReturned()) ?? (await this.fresh())
    const plan = planOf(observation, { inputs, roster })
    hooks.show(plan)
    if (isEmpty(plan)) {
      return { plan, observation }
    }
    await hooks.approve(plan)
    const current = await this.fresh()
    if (!sameJson(planOf(current, { inputs, roster }), plan)) {
      throw new InstallerError({
        code: 'INSTALLATION_PLAN_CHANGED',
        retry: RERUN,
      })
    }
    const authorization = await this.authorize(plan)
    let latest = current
    for (const action of actionsOf(plan)) {
      checkCancellation(signal)
      if (!IMAGE_ACTIONS.includes(action)) {
        await this.pin(plan)
      }
      if (action === 'update-instance') {
        await this.writeCredentials(plan)
        latest = await this.fresh()
      }
      latest = await this.step(authorization, plan, action, latest)
    }
    await this.pin(plan)
    const final = await this.fresh()
    if (!isEmpty(planOf(final, { inputs, roster }))) {
      throw unverified(this.installation.name, 'the complete installation')
    }
    return { plan, observation: final }
  }

  private async fresh(): Promise<Observation> {
    const { client, directory, sshKeygen, source, inputs } = this.context
    return await observe({ client, directory, sshKeygen, source, installation: pinned(this.installation), inputs })
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
    await records.save(this.context.directory, this.installation, next)
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
    }
    await this.persist({ authorizations: [...this.evidence.authorizations, authorization] })
    return authorization.id
  }

  private async pin(plan: ConfigurePlan): Promise<void> {
    if (plan.pin && this.installation.imageFingerprint !== plan.fingerprint) {
      this.installation = await pinImage(this.context.directory, this.installation, plan.fingerprint)
    }
  }

  /**
   * Local-only: the instance receives these files in the guarded update that
   * follows. A roster is present whenever the plan generates or replaces.
   */
  private async writeCredentials(plan: ConfigurePlan): Promise<void> {
    const { directory, sshKeygen, roster } = this.context
    if (plan.credentials === 'reuse') {
      return
    }
    if (roster === null) {
      throw new InstallerError({
        code: 'INTERNAL_ERROR',
      })
    }
    if (plan.credentials === 'generate') {
      await createCredentials(directory, roster, sshKeygen)
    } else {
      await replaceRoster(directory, roster, sshKeygen)
    }
  }

  private async step(
    authorization: string,
    plan: ConfigurePlan,
    action: InstallAction,
    observation: Observation,
  ): Promise<Observation> {
    const { client, inputs, source } = this.context
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
    const request = { accepted: false }
    try {
      await apply(action, plan, observation, {
        client,
        inputs,
        source,
        accepted: async operation => {
          request.accepted = true
          await this.persist({
            operations: [
              ...this.evidence.operations,
              { step: this.lastStep.id, id: operation.id, path: operation.path },
            ],
          })
        },
      })
    } catch (error: unknown) {
      return await this.conclude(action, error, request.accepted)
    }
    await this.amend({ completion: { exitCode: 0, completedAt: new Date().toISOString() } })
    return await this.verified(plan, action)
  }

  /**
   * A client error before the request was accepted, or a local refusal raised
   * before any request was sent, is a definite absence of effect. A completed
   * but unsuccessful operation is recorded as a nonzero completion. Anything
   * else leaves the step open, because a timeout or lost connection does not
   * show that nothing changed.
   */
  private async conclude(action: InstallAction, error: unknown, accepted: boolean): Promise<never> {
    const at = new Date().toISOString()
    if (error instanceof IncusOperationError) {
      await this.amend({ completion: { exitCode: 1, completedAt: at } })
      throw failure(action, 'uncertain', error)
    }
    const refused =
      !accepted &&
      (error instanceof InstallerError ||
        (error instanceof IncusApiError && error.statusCode >= 400 && error.statusCode < 500))
    if (refused) {
      await this.amend({ refusedAt: at })
      throw failure(action, 'refused', error)
    }
    throw failure(action, 'uncertain', error)
  }

  private async verified(plan: ConfigurePlan, action: InstallAction): Promise<Observation> {
    const observation = await this.fresh()
    if (!verify(action, plan, observation)) {
      throw unverified(this.installation.name, `step ${action}`)
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
        retry: RERUN,
      })
    }
    return await this.verified(plan, pending.action)
  }
}
