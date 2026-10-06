import { runProcess, runSetup } from '../../process'
import { runInteractive } from '../../process/interactive'
import { AWS_SPEC } from '../spec'
import type { Session } from './session'
import type { LoginFlow } from '../types'

export interface AwsCli {
  executable: string
  version: string
}

export interface AwsCliInspection {
  executable: string
  version: string | null
  compatible: boolean
}

export interface AwsCliInspectionOptions {
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export async function inspect(executable: string, options?: AwsCliInspectionOptions): Promise<AwsCliInspection> {
  const result =
    options === undefined
      ? await runProcess(executable, ['--version'], {
          maxOutputBytes: 16_384,
        })
      : await runSetup(executable, ['--version'], {
          environment: options.environment,
          signal: options.signal,
          timeoutMs: 15_000,
          maxOutputBytes: 16_384,
        })
  const version =
    /^aws-cli\/([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(`${result.stdout}\n${result.stderr}`.trim())?.[1] ?? null
  return {
    executable,
    version,
    compatible: result.exitCode === 0 && version === AWS_SPEC.cliVersion,
  }
}

export async function login(cli: AwsCli, session: Session, flow: LoginFlow, signal: AbortSignal): Promise<void> {
  await runInteractive(
    cli.executable,
    ['login', '--profile', AWS_SPEC.profile, '--region', session.region, ...(flow === 'remote' ? ['--remote'] : [])],
    {
      environment: session.environment(true),
      signal,
      timeoutMs: AWS_SPEC.loginTimeoutMs,
    },
  )
}
