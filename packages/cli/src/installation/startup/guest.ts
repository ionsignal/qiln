import waitScript from './scripts/wait.sh?raw'
import { INSTALLER_SPEC } from '../spec'
import { InstallerError } from '../../diagnostic/error'
import { toInstallerError } from '../../transport/incus/errors'
import { IncusApiError, IncusCancelledError, type IncusClient } from '../../transport/incus/client'
import type { StepOutcome } from '../../host/step'
import type { IncusOperation, IncusOperationRef } from '../../transport/incus/types'
import type { Admin, StartupAction, UnitAction } from './types'

const { startup, orchestrator } = INSTALLER_SPEC

type Check = keyof typeof startup.waitSeconds

/**
 * Identifies the polling script bytes for the approval recipe.
 */
export const WAIT_SCRIPT = waitScript

const returned: StepOutcome = { kind: 'returned' }

/**
 * The unit takes its environment from the same files as the development
 * services, so nothing is reconstructed here. No UMask is set, because build
 * output must keep normal permissions in the shared checkout.
 */
function unitCommand(action: UnitAction): string[] {
  return [
    '/usr/bin/systemd-run',
    '--wait',
    '--collect',
    '--quiet',
    `--unit=${startup.unit}`,
    `--property=User=${startup.user}`,
    `--property=Group=${startup.group}`,
    `--property=WorkingDirectory=${orchestrator.sourceMountPath}`,
    ...startup.environmentFiles.map(file => `--property=EnvironmentFile=${file}`),
    `--setenv=QILN_HOST_CREDENTIAL_PATH=${startup.hostCredentialPath}`,
    `--setenv=QILN_BOOTSTRAP_ADMIN_FILE=${startup.adminFile}`,
    ...startup.commands[action],
  ]
}

function exited({ exitCode }: IncusOperation): StepOutcome {
  if (exitCode === 0) {
    return returned
  }
  return {
    kind: 'uncertain',
    reason: exitCode === null ? 'The command reported no exit code.' : `The command exited with code ${exitCode}.`,
    exitCode,
    cause: null,
  }
}

/**
 * Everything that touches the running orchestrator through Incus. Guest
 * commands run as root exec, and the unit-based ones hand off to systemd.
 */
export class Guest {
  constructor(
    private readonly client: IncusClient,
    private readonly retry: string,
  ) {}

  public run(action: StartupAction): Promise<StepOutcome> {
    switch (action) {
      case 'start-instance':
        return this.attempt(
          () => this.client.startInstance(orchestrator.name),
          () => returned,
        )
      case 'start-services':
        return this.exec(['/usr/bin/systemctl', 'start', ...startup.services])
      default:
        return this.exec(unitCommand(action))
    }
  }

  public running(): Promise<boolean> {
    return this.guarded(
      'read the orchestrator status',
      async () => (await this.client.getInstance(orchestrator.name)).status === 'Running',
    )
  }

  /**
   * Whether the guest passed the check within the given seconds. Zero checks once.
   */
  public wait(check: Check, seconds = startup.waitSeconds[check]): Promise<boolean> {
    return this.guarded('wait for the orchestrator guest', async () => {
      const operation = await this.client.execInstance(orchestrator.name, [
        '/bin/sh',
        '-c',
        waitScript,
        'qiln',
        check,
        String(seconds),
      ])
      return (await this.client.waitOperation(operation)).exitCode === 0
    })
  }

  /**
   * The script reads the file once and unlinks it, so the password only exists
   * in the guest between this write and that read.
   */
  public writeAdmin(admin: Admin): Promise<void> {
    const { adminFile, uid, gid } = startup
    return this.guarded('write the administrator file into the orchestrator', () =>
      this.client.writeInstanceFile(orchestrator.name, adminFile, new TextEncoder().encode(JSON.stringify(admin)), {
        uid,
        gid,
        mode: '0600',
      }),
    )
  }

  private exec(command: readonly string[]): Promise<StepOutcome> {
    return this.attempt(() => this.client.execInstance(orchestrator.name, command), exited)
  }

  /**
   * A rejected request is a definite absence of effect. Once Incus accepted the
   * operation, or when the outcome is unknown, the step may have run partly or
   * fully. A cancellation is thrown, which leaves the step open as evidence.
   */
  private async attempt(
    start: () => Promise<IncusOperationRef>,
    judge: (operation: IncusOperation) => StepOutcome,
  ): Promise<StepOutcome> {
    let accepted = false
    try {
      const operation = await start()
      accepted = true
      return judge(await this.client.waitOperation(operation))
    } catch (error: unknown) {
      if (error instanceof IncusCancelledError) {
        throw new InstallerError({ code: 'COMMAND_CANCELLED' })
      }
      if (!accepted && error instanceof IncusApiError && error.statusCode >= 400 && error.statusCode < 500) {
        return { kind: 'refused', reason: `Incus rejected the request with HTTP ${error.statusCode}.`, cause: null }
      }
      return {
        kind: 'uncertain',
        reason: 'The Incus request or its operation did not complete reliably.',
        exitCode: null,
        cause: null,
      }
    }
  }

  private async guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      throw toInstallerError(error, { check: 'installation startup', operation, rerun: this.retry })
    }
  }
}
